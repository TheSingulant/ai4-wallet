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
  generation?: SigningGeneration;
  /** Generation this attempt captured when it started. */
  attemptGeneration?: number;
  liveSession?: () => SigningSession;
  liveForm?: () => TransferForm;
  liveWallet?: () => WalletSnapshot;
  /** False when the current constraint result is no longer ALLOW. */
  constraintStillAllow?: () => boolean;
  /**
   * Fresh Phantom provider public key. Read synchronously after the awaits,
   * inside the critical section. Not the cached wallet snapshot.
   */
  readProviderPublicKey?: () => string | null;
  timeoutMs?: number;
  sign: (transaction: Transaction) => Promise<Transaction>;
  onReadiness?: (readiness: Phase1SigningReadiness) => void;
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
  const timeoutMs = input.timeoutMs ?? RPC_TIMEOUT_MS;
  const source = input.generation ?? { current: input.session.generation };
  const attempt = input.attemptGeneration ?? source.current;
  const liveSession = input.liveSession ?? (() => input.session);
  const liveForm = input.liveForm ?? (() => input.form);
  const liveWallet = input.liveWallet ?? (() => input.wallet);
  const constraintStillAllow = input.constraintStillAllow ?? (() => true);
  const readProviderPublicKey = input.readProviderPublicKey ?? (() => input.wallet.publicKey ?? null);

  const current = input.session.prepared;
  if (input.candidate !== undefined && input.candidate !== current) {
    return { session: input.session, phantomCalled: false };
  }
  if (!openForSign(input.session) || current === null) {
    return { session: input.session, phantomCalled: false };
  }
  const prepared = current;
  if (source.current !== attempt || liveSession().prepared !== prepared) {
    return invalidated(input, liveSession, prepared, attempt, input.session.genesis);
  }
  if (!connectedPhantom(input.wallet) || input.wallet.publicKey !== prepared.feePayer) {
    return {
      session: unavailable("wallet is not the prepared fee payer", input.session.genesis, attempt),
      phantomCalled: false,
    };
  }
  if (!bindingStillMatches(liveForm(), liveSession(), prepared) || !constraintStillAllow()) {
    return {
      session: unavailable("form does not match the prepared transfer", input.session.genesis, attempt),
      phantomCalled: false,
    };
  }

  const genesis = await verifyAppDevnetGenesis(input.genesisRpc, timeoutMs);
  if (source.current !== attempt || liveSession().prepared !== prepared) {
    return invalidated(input, liveSession, prepared, attempt, genesis);
  }
  if (!genesis.ok) {
    return {
      session: unavailable(genesis.reason ?? "genesis freshness check failed", genesis, attempt),
      phantomCalled: false,
    };
  }
  if (!bindingStillMatches(liveForm(), liveSession(), prepared) || !constraintStillAllow()) {
    return {
      session: unavailable("form does not match the prepared transfer", genesis, attempt),
      phantomCalled: false,
    };
  }
  if (!walletStillFeePayer(liveWallet(), prepared) || !walletStillFeePayer(input.wallet, prepared)) {
    return {
      session: unavailable("wallet is not the prepared fee payer", genesis, attempt),
      phantomCalled: false,
    };
  }

  const freshness = await blockhashStillValid(input.blockhashProbe, prepared, timeoutMs);
  if (source.current !== attempt || liveSession().prepared !== prepared) {
    return invalidated(input, liveSession, prepared, attempt, genesis);
  }
  if (!freshness.valid) {
    return {
      session: unavailable(freshness.reason, genesis, attempt),
      phantomCalled: false,
    };
  }
  if (!bindingStillMatches(liveForm(), liveSession(), prepared) || !constraintStillAllow()) {
    return {
      session: unavailable("form does not match the prepared transfer", genesis, attempt),
      phantomCalled: false,
    };
  }
  if (!walletStillFeePayer(liveWallet(), prepared) || !walletStillFeePayer(input.wallet, prepared)) {
    return {
      session: unavailable("wallet is not the prepared fee payer", genesis, attempt),
      phantomCalled: false,
    };
  }

  // Readiness updates finish before the critical section. They are not between
  // the byte compare and sign.
  input.onReadiness?.("signing");
  if (source.current !== attempt || liveSession().prepared !== prepared) {
    return invalidated(input, liveSession, prepared, attempt, genesis);
  }
  if (!bindingStillMatches(liveForm(), liveSession(), prepared) || !constraintStillAllow()) {
    return {
      session: unavailable("form does not match the prepared transfer", genesis, attempt),
      phantomCalled: false,
    };
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
    return {
      session: unavailable(committed.reason, genesis, attempt),
      phantomCalled: false,
    };
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
