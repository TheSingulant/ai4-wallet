import { PRODUCT } from "../copy";
import { parseSolAmount } from "./amount";
import { validateSolanaAddress } from "./address";
import { bytesEqual, canonicalBindingJson, copyBytes, sha256Bytes, sha256Hex } from "./canonical";
import { isDevnet } from "./devnetGuard";
import {
  RPC_TIMEOUT_MS,
  verifyAppDevnetGenesis,
  type GenesisRpc,
  type LiveGenesisCheck,
} from "./genesisLive";
import {
  buildLegacySolTransfer,
  commitExactMessageSign,
  isExactBlockhash,
  publicKeyOrNull,
  sealPreparedTransfer,
  verifyFeePayerSignature,
  type PreparedTransfer,
} from "./nativeTransfer";
import { isTimeoutError, withTimeout } from "./timeout";
import {
  PHASE0_ACTION,
  PHASE0_ASSET,
  REQUIRED_NETWORK,
  type ApprovedBinding,
  type ProductDecision,
  type WalletSnapshot,
} from "./types";
import type { BlockhashFreshness, BlockhashSource } from "../solana/devnetConnection";
import type { Transaction } from "@solana/web3.js";

export type Phase1SigningReadiness =
  | "unavailable"
  | "preparing"
  | "ready"
  | "signing"
  | "signed"
  | "failed";

export interface TransferForm {
  readonly amount: string;
  readonly destination: string;
  readonly network: string;
  readonly serializedTx: string;
}

export interface LocalSignedResult {
  readonly messageSha256: string;
  readonly signature: Uint8Array;
  readonly signedBytes: Uint8Array;
  readonly broadcast: false;
}

/** Monotonic token. Callers increment `current` to invalidate an in-flight sign. */
export interface SigningGeneration {
  current: number;
}

export interface SigningSession {
  readonly readiness: Phase1SigningReadiness;
  readonly prepared: PreparedTransfer | null;
  readonly signed: LocalSignedResult | null;
  readonly genesis: LiveGenesisCheck | null;
  readonly note: string;
  readonly formSnapshot: TransferForm | null;
  /** Generation captured when this session was prepared or dropped. */
  readonly generation: number;
  /** True from the start of a sign attempt until that attempt finishes or aborts. */
  readonly inFlight: boolean;
}

export interface PrepareInput {
  decision: ProductDecision;
  constraintResult: "ALLOW" | "REVISE" | "REFUSE" | null;
  binding: ApprovedBinding | null;
  bindingSha256: string | null;
  serializedTx: string | null;
  wallet: WalletSnapshot;
  form: TransferForm;
  genesisRpc: GenesisRpc;
  blockhashRpc: BlockhashSource;
  timeoutMs?: number;
  nowMs?: number;
  generation?: number;
}

export interface SignInput {
  session: SigningSession;
  wallet: WalletSnapshot;
  form: TransferForm;
  genesisRpc: GenesisRpc;
  blockhashProbe: BlockhashFreshness;
  /**
   * When set, this object must be the session's current prepared transfer.
   * An older prepared transfer is refused and Phantom is not called.
   */
  candidate?: PreparedTransfer;
  /**
   * Shared generation. After every await, and again inside the synchronous
   * critical section, a change aborts the attempt before Phantom is called.
   */
  generation: SigningGeneration;
  /** Generation this attempt captured when it started. */
  attemptGeneration: number;
  liveSession: () => SigningSession;
  liveForm: () => TransferForm;
  liveWallet: () => WalletSnapshot;
  /** False when the current constraint result is no longer ALLOW. */
  constraintStillAllow: () => boolean;
  /**
   * Fresh Phantom provider public key. Read synchronously after the awaits,
   * inside the critical section. Not the cached wallet snapshot.
   */
  readProviderPublicKey: () => string | null;
  timeoutMs?: number;
  sign: (transaction: Transaction) => Promise<Transaction>;
  onReadiness?: (readiness: Phase1SigningReadiness) => void;
}

/**
 * Every live guard must be present. A missing reader is not filled from the
 * captured snapshot. Phantom is not called.
 */
export function liveSignGuardsPresent(input: {
  generation?: unknown;
  attemptGeneration?: unknown;
  liveSession?: unknown;
  liveForm?: unknown;
  liveWallet?: unknown;
  constraintStillAllow?: unknown;
  readProviderPublicKey?: unknown;
}): boolean {
  if (!isSigningGeneration(input.generation)) {
    return false;
  }
  if (typeof input.attemptGeneration !== "number" || !Number.isFinite(input.attemptGeneration)) {
    return false;
  }
  return (
    typeof input.liveSession === "function" &&
    typeof input.liveForm === "function" &&
    typeof input.liveWallet === "function" &&
    typeof input.constraintStillAllow === "function" &&
    typeof input.readProviderPublicKey === "function"
  );
}

function isSigningGeneration(value: unknown): value is SigningGeneration {
  if (typeof value !== "object" || value === null || !("current" in value)) {
    return false;
  }
  const current = (value as { current?: unknown }).current;
  return typeof current === "number" && Number.isFinite(current);
}

export interface SignOutcome {
  readonly session: SigningSession;
  readonly phantomCalled: boolean;
}

export function emptySigningSession(): SigningSession {
  return sealSession({
    readiness: "unavailable",
    prepared: null,
    signed: null,
    genesis: null,
    note: "Signing readiness is unavailable.",
    formSnapshot: null,
    generation: 0,
    inFlight: false,
  });
}

export function beginPreparing(session: SigningSession, generation = session.generation): SigningSession {
  return sealSession({
    readiness: "preparing",
    prepared: null,
    signed: null,
    genesis: null,
    note: "Preparing a DevNet transfer.",
    formSnapshot: null,
    generation,
    inFlight: false,
  });
}

export function invalidateSigningSession(
  session: SigningSession,
  note: string,
  generation = session.generation,
): SigningSession {
  return sealSession({
    readiness: "unavailable",
    prepared: null,
    signed: null,
    genesis: session.genesis,
    note,
    formSnapshot: null,
    generation,
    inFlight: false,
  });
}

/** Sign and Prepare stay disabled while this is true. */
export function signingControlsLocked(session: Pick<SigningSession, "inFlight" | "readiness">): boolean {
  return session.inFlight || session.readiness === "signing" || session.readiness === "preparing";
}

/**
 * DevNet blockhashes last about 60 to 90 seconds.
 * The page expires at 60 seconds. It does not write a new blockhash onto the old record.
 */
export const PREPARED_TRANSFER_TTL_MS = 60_000;

export function preparedExpiresAtMs(prepared: PreparedTransfer): number {
  return prepared.preparedAtMs + PREPARED_TRANSFER_TTL_MS;
}

export function isPreparedExpired(prepared: PreparedTransfer, nowMs: number): boolean {
  return nowMs >= preparedExpiresAtMs(prepared);
}

/**
 * Move a ready session to failed when the visible window has elapsed.
 * The prepared blockhash is left as it was. A later prepare builds a new record.
 */
export function expirePreparedSession(
  session: SigningSession,
  nowMs: number,
  generation = session.generation,
): SigningSession {
  if (session.readiness !== "ready" || session.prepared === null || session.inFlight) {
    return session;
  }
  if (!isPreparedExpired(session.prepared, nowMs)) {
    return session;
  }
  const blockhash = session.prepared.blockhash;
  const expired = failed(
    PRODUCT.preparedExpired,
    session.prepared,
    session.genesis,
    session.formSnapshot,
    generation,
  );
  if (expired.prepared?.blockhash !== blockhash) {
    return failed("prepared transfer blockhash changed", null, session.genesis, null, generation);
  }
  return expired;
}

/** A visible sign or prepare refusal. The blockhash on `prepared` is not rewritten. */
export function failSigningSession(
  session: SigningSession,
  note: string,
  generation = session.generation,
  prepared: SigningSession["prepared"] = session.prepared,
): SigningSession {
  return failed(note, prepared, session.genesis, session.formSnapshot, generation);
}

export function replaceSigningNote(session: SigningSession, note: string): SigningSession {
  return sealSession({
    readiness: session.readiness,
    prepared: session.prepared,
    signed: session.signed,
    genesis: session.genesis,
    note,
    formSnapshot: session.formSnapshot,
    generation: session.generation,
    inFlight: session.inFlight,
  });
}

export function markSigningAttempt(session: SigningSession): SigningSession {
  return sealSession({
    readiness: "signing",
    prepared: session.prepared,
    signed: null,
    genesis: session.genesis,
    note: "Waiting for Phantom signTransaction.",
    formSnapshot: session.formSnapshot,
    generation: session.generation,
    inFlight: true,
  });
}

/**
 * Constraint ALLOW is not signing readiness.
 * ready requires a connected Phantom identity, a passed genesis check,
 * ALLOW, a valid six-field binding, a built exact message, a stored message hash,
 * and a form that still matches that binding.
 */
export function derivePhase1Readiness(input: {
  status: "idle" | "preparing" | "signing" | "signed" | "failed";
  connected: boolean;
  genesisOk: boolean;
  allow: boolean;
  bindingValid: boolean;
  messageBuilt: boolean;
  messageHashStored: boolean;
  formMatches: boolean;
}): Phase1SigningReadiness {
  if (input.status === "preparing") {
    return "preparing";
  }
  if (input.status === "signing") {
    return "signing";
  }
  if (input.status === "failed") {
    return "failed";
  }
  const ready =
    input.connected &&
    input.genesisOk &&
    input.allow &&
    input.bindingValid &&
    input.messageBuilt &&
    input.messageHashStored &&
    input.formMatches;
  if (!ready) {
    return "unavailable";
  }
  if (input.status === "signed") {
    return "signed";
  }
  return "ready";
}

export async function approvedBindingValid(
  binding: ApprovedBinding,
  sha256: string,
): Promise<boolean> {
  if (binding.network !== REQUIRED_NETWORK) {
    return false;
  }
  if (binding.asset !== PHASE0_ASSET || binding.action !== PHASE0_ACTION) {
    return false;
  }
  const amount = parseSolAmount(binding.amount_sol);
  if (!amount.ok) {
    return false;
  }
  if (amount.value.amount_sol !== binding.amount_sol || amount.value.lamports !== binding.lamports) {
    return false;
  }
  const destination = validateSolanaAddress(binding.destination);
  if (!destination.ok || destination.address !== binding.destination) {
    return false;
  }
  const digest = await sha256Hex(canonicalBindingJson(binding));
  return digest === sha256;
}

export function formMatchesBinding(args: {
  form: TransferForm;
  binding: ApprovedBinding;
  serializedTx: string;
}): boolean {
  if (!isDevnet(args.form.network) || args.binding.network !== REQUIRED_NETWORK) {
    return false;
  }
  const amount = parseSolAmount(args.form.amount);
  if (!amount.ok) {
    return false;
  }
  if (amount.value.amount_sol !== args.binding.amount_sol || amount.value.lamports !== args.binding.lamports) {
    return false;
  }
  const destination = validateSolanaAddress(args.form.destination);
  if (!destination.ok || destination.address !== args.binding.destination) {
    return false;
  }
  return args.form.serializedTx === args.serializedTx;
}

export async function runPrepare(input: PrepareInput): Promise<SigningSession> {
  const timeoutMs = input.timeoutMs ?? RPC_TIMEOUT_MS;
  const generation = input.generation ?? 0;
  const rejectPrepare = (note: string, genesisCheck: LiveGenesisCheck | null = null) =>
    unavailable(note, genesisCheck, generation);
  const walletOk = connectedPhantom(input.wallet);
  if (!walletOk) {
    return rejectPrepare("wallet is not a connected Phantom identity");
  }
  if (input.decision !== "ALLOW" || input.constraintResult !== "ALLOW") {
    return rejectPrepare("constraint result is not ALLOW");
  }
  if (!input.binding || !input.bindingSha256 || !input.serializedTx) {
    return rejectPrepare("ALLOW snapshot is missing a binding");
  }
  const binding = input.binding;
  const bindingSha256 = input.bindingSha256;
  const serializedTx = input.serializedTx;
  const bindingValid = await approvedBindingValid(binding, bindingSha256);
  if (!bindingValid) {
    return rejectPrepare("approved binding hash does not match the canonical payload");
  }
  if (!formMatchesBinding({ form: input.form, binding, serializedTx })) {
    return rejectPrepare("form does not match the approved binding");
  }
  const feePayer = publicKeyOrNull(input.wallet.publicKey ?? "");
  const destination = publicKeyOrNull(binding.destination);
  if (!feePayer || !destination || feePayer.toBase58() !== input.wallet.publicKey) {
    return rejectPrepare("fee payer is not a Solana public key");
  }

  const genesis = await verifyAppDevnetGenesis(input.genesisRpc, timeoutMs);
  if (!genesis.ok) {
    return rejectPrepare(genesis.reason ?? "genesis check failed", genesis);
  }

  let blockhash: { blockhash: string; lastValidBlockHeight: number };
  try {
    blockhash = await withTimeout(input.blockhashRpc.getLatestBlockhash(), timeoutMs);
  } catch (error) {
    const reason = isTimeoutError(error)
      ? "blockhash request timed out"
      : "blockhash request failed";
    return rejectPrepare(reason, genesis);
  }
  if (!isExactBlockhash(blockhash.blockhash)) {
    return rejectPrepare("blockhash is not 32-byte base58", genesis);
  }
  if (!Number.isInteger(blockhash.lastValidBlockHeight) || blockhash.lastValidBlockHeight < 0) {
    return rejectPrepare("blockhash response is missing expiry data", genesis);
  }

  let transaction;
  try {
    transaction = buildLegacySolTransfer({
      feePayer,
      destination,
      lamports: binding.lamports,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    });
  } catch {
    return rejectPrepare("DevNet transfer could not be built", genesis);
  }
  const sealed = await sealPreparedTransfer({
    transaction,
    binding,
    bindingSha256,
    preparedAtMs: input.nowMs ?? Date.now(),
  });
  if (!sealed.ok) {
    return rejectPrepare(sealed.reason, genesis);
  }
  const formSnapshot: TransferForm = Object.freeze({
    amount: input.form.amount,
    destination: input.form.destination,
    network: input.form.network,
    serializedTx: input.form.serializedTx,
  });
  return sealSession({
    readiness: "ready",
    prepared: sealed.prepared,
    signed: null,
    genesis,
    note: "Exact message is ready for a local signature.",
    formSnapshot,
    generation: input.generation ?? 0,
    inFlight: false,
  });
}

/**
 * Phantom is called only after every pre-check passes.
 * Async RPC work finishes before the synchronous critical section.
 * A mismatch clears readiness and does not call Phantom.
 * Blockhash expiry does not write a new blockhash onto the old prepared transfer.
 *
 * The critical section compares serializeMessage() to the frozen bytes and
 * calls sign on that same Transaction with no await and no callback between them.
 */
export async function signIfGated(input: SignInput): Promise<SignOutcome> {
  if (!liveSignGuardsPresent(input)) {
    return {
      session: failed(
        "Sign stopped before Phantom. Signing guards are incomplete.",
        input.session.prepared,
        input.session.genesis,
        input.session.formSnapshot,
        finiteGeneration(input.attemptGeneration, input.session.generation),
      ),
      phantomCalled: false,
    };
  }
  const timeoutMs = input.timeoutMs ?? RPC_TIMEOUT_MS;
  const source = input.generation;
  const attempt = input.attemptGeneration;
  const liveSession = input.liveSession;
  const liveForm = input.liveForm;
  const liveWallet = input.liveWallet;
  const constraintStillAllow = input.constraintStillAllow;
  const readProviderPublicKey = input.readProviderPublicKey;

  const current = input.session.prepared;
  if (input.candidate !== undefined && input.candidate !== current) {
    if (input.session.inFlight || input.session.readiness === "signing") {
      return refuse(
        "Sign stopped before Phantom. The prepared transfer changed.",
        current,
        input.session.genesis,
        input.session.formSnapshot,
        attempt,
      );
    }
    return { session: input.session, phantomCalled: false };
  }
  if (!openForSign(input.session) || current === null) {
    return notOpenForSign(input.session, attempt);
  }
  const prepared = current;
  if (source.current !== attempt || liveSession().prepared !== prepared) {
    return invalidated(input, liveSession, prepared, attempt, input.session.genesis);
  }
  if (!connectedPhantom(input.wallet) || input.wallet.publicKey !== prepared.feePayer) {
    return refuse(
      "wallet is not the prepared fee payer",
      prepared,
      input.session.genesis,
      input.session.formSnapshot,
      attempt,
    );
  }
  if (!bindingStillMatches(liveForm(), liveSession(), prepared) || !constraintStillAllow()) {
    return refuse(
      "form does not match the prepared transfer",
      prepared,
      input.session.genesis,
      input.session.formSnapshot,
      attempt,
    );
  }

  const genesis = await verifyAppDevnetGenesis(input.genesisRpc, timeoutMs);
  if (source.current !== attempt || liveSession().prepared !== prepared) {
    return invalidated(input, liveSession, prepared, attempt, genesis);
  }
  if (!genesis.ok) {
    return refuse(
      genesis.reason ?? "genesis freshness check failed",
      prepared,
      genesis,
      input.session.formSnapshot,
      attempt,
    );
  }
  if (!bindingStillMatches(liveForm(), liveSession(), prepared) || !constraintStillAllow()) {
    return refuse("form does not match the prepared transfer", prepared, genesis, input.session.formSnapshot, attempt);
  }
  if (!walletStillFeePayer(liveWallet(), prepared) || !walletStillFeePayer(input.wallet, prepared)) {
    return refuse("wallet is not the prepared fee payer", prepared, genesis, input.session.formSnapshot, attempt);
  }

  const freshness = await blockhashStillValid(input.blockhashProbe, prepared, timeoutMs);
  if (source.current !== attempt || liveSession().prepared !== prepared) {
    return invalidated(input, liveSession, prepared, attempt, genesis);
  }
  if (!freshness.valid) {
    const note = isBlockhashExpiry(freshness.reason) ? PRODUCT.preparedExpired : freshness.reason;
    return refuse(note, prepared, genesis, input.session.formSnapshot, attempt);
  }
  if (!bindingStillMatches(liveForm(), liveSession(), prepared) || !constraintStillAllow()) {
    return refuse("form does not match the prepared transfer", prepared, genesis, input.session.formSnapshot, attempt);
  }
  if (!walletStillFeePayer(liveWallet(), prepared) || !walletStillFeePayer(input.wallet, prepared)) {
    return refuse("wallet is not the prepared fee payer", prepared, genesis, input.session.formSnapshot, attempt);
  }

  // Readiness updates finish before the critical section. They are not between
  // the byte compare and sign.
  input.onReadiness?.("signing");
  if (source.current !== attempt || liveSession().prepared !== prepared) {
    return invalidated(input, liveSession, prepared, attempt, genesis);
  }
  if (!bindingStillMatches(liveForm(), liveSession(), prepared) || !constraintStillAllow()) {
    return refuse("form does not match the prepared transfer", prepared, genesis, input.session.formSnapshot, attempt);
  }

  let committed;
  try {
    committed = commitExactMessageSign({
      prepared,
      generation: source,
      attemptGeneration: attempt,
      livePrepared: () => liveSession().prepared,
      formMatches: () => bindingStillMatches(liveForm(), liveSession(), prepared),
      constraintAllows: constraintStillAllow,
      providerPublicKey: readProviderPublicKey,
      walletPublicKey: () => {
        const walletNow = liveWallet();
        return walletNow.status === "connected" ? walletNow.publicKey : null;
      },
      sign: input.sign,
    });
  } catch {
    return {
      session: failed(
        "Phantom signTransaction was rejected",
        prepared,
        genesis,
        input.session.formSnapshot,
        attempt,
      ),
      phantomCalled: true,
    };
  }
  if (!committed.ok) {
    return refuse(committed.reason, prepared, genesis, input.session.formSnapshot, attempt);
  }

  let signedTransaction: Transaction;
  try {
    signedTransaction = await committed.pending;
  } catch {
    return {
      session: failed(
        "Phantom signTransaction was rejected",
        prepared,
        genesis,
        input.session.formSnapshot,
        attempt,
      ),
      phantomCalled: true,
    };
  }
  if (source.current !== attempt || liveSession().prepared !== prepared) {
    return invalidated(input, liveSession, prepared, attempt, genesis, true);
  }

  let signedMessage: Uint8Array;
  try {
    signedMessage = signedTransaction.serializeMessage();
  } catch {
    return {
      session: failed("signed transaction message could not be read", null, genesis, null, attempt),
      phantomCalled: true,
    };
  }
  if (!bytesEqual(signedMessage, prepared.messageBytes)) {
    return {
      session: failed("signed message does not match the prepared message", null, genesis, null, attempt),
      phantomCalled: true,
    };
  }
  const signedHash = await sha256Bytes(signedMessage);
  if (source.current !== attempt || liveSession().prepared !== prepared) {
    return invalidated(input, liveSession, prepared, attempt, genesis, true);
  }
  if (signedHash !== prepared.messageSha256) {
    return {
      session: failed("signed message does not match the prepared message", null, genesis, null, attempt),
      phantomCalled: true,
    };
  }
  const signatureVerified = await verifyFeePayerSignature(signedTransaction, prepared.feePayer, signedMessage);
  if (source.current !== attempt || liveSession().prepared !== prepared) {
    return invalidated(input, liveSession, prepared, attempt, genesis, true);
  }
  if (!signatureVerified) {
    return {
      session: failed(
        "returned signature does not verify for the fee payer",
        prepared,
        genesis,
        input.session.formSnapshot,
        attempt,
      ),
      phantomCalled: true,
    };
  }
  const signature = signedTransaction.signature;
  if (!signature || signature.byteLength !== 64) {
    return {
      session: failed(
        "Phantom did not return a signature",
        prepared,
        genesis,
        input.session.formSnapshot,
        attempt,
      ),
      phantomCalled: true,
    };
  }
  let wire: Uint8Array;
  try {
    wire = copyBytes(signedTransaction.serialize({ requireAllSignatures: true, verifySignatures: true }));
  } catch {
    return {
      session: failed(
        "returned signature does not verify for the fee payer",
        prepared,
        genesis,
        input.session.formSnapshot,
        attempt,
      ),
      phantomCalled: true,
    };
  }
  const storedSignature = copyBytes(signature);
  const signed = Object.freeze({
    messageSha256: prepared.messageSha256,
    get signature(): Uint8Array {
      return copyBytes(storedSignature);
    },
    get signedBytes(): Uint8Array {
      return copyBytes(wire);
    },
    broadcast: false as const,
  });
  return {
    session: sealSession({
      readiness: "signed",
      prepared,
      signed,
      genesis,
      note: "Signed locally. Not broadcast.",
      formSnapshot: input.session.formSnapshot,
      generation: attempt,
      inFlight: false,
    }),
    phantomCalled: true,
  };
}

async function blockhashStillValid(
  probe: BlockhashFreshness,
  prepared: PreparedTransfer,
  timeoutMs: number,
): Promise<{ valid: true } | { valid: false; reason: string }> {
  try {
    const [valid, height] = await withTimeout(
      Promise.all([probe.isBlockhashValid(prepared.blockhash), probe.getBlockHeight()]),
      timeoutMs,
    );
    if (valid !== true) {
      return { valid: false, reason: "blockhash is no longer valid" };
    }
    if (!Number.isInteger(height) || height > prepared.lastValidBlockHeight) {
      return { valid: false, reason: "blockhash expired at the current block height" };
    }
    return { valid: true };
  } catch (error) {
    if (isTimeoutError(error)) {
      return { valid: false, reason: "blockhash validity request timed out" };
    }
    return { valid: false, reason: "blockhash validity request failed" };
  }
}

function connectedPhantom(wallet: WalletSnapshot): wallet is WalletSnapshot & { publicKey: string } {
  return (
    wallet.status === "connected" &&
    wallet.source === "phantom" &&
    typeof wallet.publicKey === "string" &&
    wallet.publicKey.trim() !== ""
  );
}

function finiteGeneration(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isBlockhashExpiry(reason: string): boolean {
  return reason === "blockhash is no longer valid" || reason === "blockhash expired at the current block height";
}

function refuse(
  note: string,
  prepared: PreparedTransfer | null,
  genesis: LiveGenesisCheck | null,
  formSnapshot: TransferForm | null,
  generation: number,
): SignOutcome {
  return {
    session: failed(note, prepared, genesis, formSnapshot, generation),
    phantomCalled: false,
  };
}

function notOpenForSign(session: SigningSession, generation: number): SignOutcome {
  if (session.readiness === "signed") {
    return { session, phantomCalled: false };
  }
  if (session.readiness === "failed" && session.note.trim() !== "") {
    return { session, phantomCalled: false };
  }
  if (session.readiness === "preparing" && session.note.trim() !== "") {
    return { session, phantomCalled: false };
  }
  if (
    session.readiness === "unavailable" &&
    session.note.trim() !== "" &&
    session.note !== "Waiting for Phantom signTransaction." &&
    session.note !== "Signing readiness is unavailable."
  ) {
    return { session, phantomCalled: false };
  }
  const note =
    session.readiness === "signing" || session.note === "Waiting for Phantom signTransaction."
      ? "Sign stopped before Phantom. No prepared transfer is open to sign."
      : "No prepared transfer is ready to sign.";
  return refuse(note, session.prepared, session.genesis, session.formSnapshot, generation);
}

function unavailable(note: string, genesis: LiveGenesisCheck | null, generation = 0): SigningSession {
  return sealSession({
    readiness: "unavailable",
    prepared: null,
    signed: null,
    genesis,
    note,
    formSnapshot: null,
    generation,
    inFlight: false,
  });
}

function failed(
  note: string,
  prepared: PreparedTransfer | null,
  genesis: LiveGenesisCheck | null,
  formSnapshot: TransferForm | null,
  generation: number,
): SigningSession {
  return sealSession({
    readiness: "failed",
    prepared,
    signed: null,
    genesis,
    note,
    formSnapshot,
    generation,
    inFlight: false,
  });
}

function openForSign(session: SigningSession): boolean {
  if (session.prepared === null) {
    return false;
  }
  if (session.readiness === "ready" && !session.inFlight) {
    return true;
  }
  return session.readiness === "signing" && session.inFlight;
}

function bindingStillMatches(
  form: TransferForm,
  session: SigningSession,
  prepared: PreparedTransfer,
): boolean {
  return formMatchesBinding({
    form,
    binding: prepared.binding,
    serializedTx: session.formSnapshot?.serializedTx ?? "",
  });
}

function walletStillFeePayer(wallet: WalletSnapshot, prepared: PreparedTransfer): boolean {
  return connectedPhantom(wallet) && wallet.publicKey === prepared.feePayer;
}

function invalidated(
  _input: SignInput,
  liveSession: () => SigningSession,
  intended: PreparedTransfer,
  attempt: number,
  genesis: LiveGenesisCheck | null,
  phantomCalled = false,
): SignOutcome {
  const live = liveSession();
  if (live.prepared !== intended) {
    return { session: live, phantomCalled };
  }
  return {
    session: unavailable("signing session was invalidated", genesis ?? live.genesis, attempt),
    phantomCalled,
  };
}

function sealSession(session: SigningSession): SigningSession {
  return Object.freeze({
    readiness: session.readiness,
    prepared: session.prepared,
    signed: session.signed,
    genesis: session.genesis,
    note: session.note,
    formSnapshot: session.formSnapshot,
    generation: session.generation,
    inFlight: session.inFlight,
  });
}
