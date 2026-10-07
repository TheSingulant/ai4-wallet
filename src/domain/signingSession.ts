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
  exactTransaction,
  preSignRecheck,
  publicKeyOrNull,
  sealPreparedTransfer,
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

export interface SigningSession {
  readonly readiness: Phase1SigningReadiness;
  readonly prepared: PreparedTransfer | null;
  readonly signed: LocalSignedResult | null;
  readonly genesis: LiveGenesisCheck | null;
  readonly note: string;
  readonly formSnapshot: TransferForm | null;
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
  });
}

export function beginPreparing(session: SigningSession): SigningSession {
  return sealSession({
    readiness: "preparing",
    prepared: null,
    signed: null,
    genesis: null,
    note: "Preparing a DevNet transfer.",
    formSnapshot: null,
  });
}

export function invalidateSigningSession(session: SigningSession, note: string): SigningSession {
  return sealSession({
    readiness: "unavailable",
    prepared: null,
    signed: null,
    genesis: session.genesis,
    note,
    formSnapshot: null,
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
  const walletOk = connectedPhantom(input.wallet);
  if (!walletOk) {
    return unavailable("wallet is not a connected Phantom identity", null);
  }
  if (input.decision !== "ALLOW" || input.constraintResult !== "ALLOW") {
    return unavailable("constraint result is not ALLOW", null);
  }
  if (!input.binding || !input.bindingSha256 || !input.serializedTx) {
    return unavailable("ALLOW snapshot is missing a binding", null);
  }
  const binding = input.binding;
  const bindingSha256 = input.bindingSha256;
  const serializedTx = input.serializedTx;
  const bindingValid = await approvedBindingValid(binding, bindingSha256);
  if (!bindingValid) {
    return unavailable("approved binding hash does not match the canonical payload", null);
  }
  if (!formMatchesBinding({ form: input.form, binding, serializedTx })) {
    return unavailable("form does not match the approved binding", null);
  }
  const feePayer = publicKeyOrNull(input.wallet.publicKey ?? "");
  const destination = publicKeyOrNull(binding.destination);
  if (!feePayer || !destination || feePayer.toBase58() !== input.wallet.publicKey) {
    return unavailable("fee payer is not a Solana public key", null);
  }

  const genesis = await verifyAppDevnetGenesis(input.genesisRpc, timeoutMs);
  if (!genesis.ok) {
    return unavailable(genesis.reason ?? "genesis check failed", genesis);
  }

  let blockhash: { blockhash: string; lastValidBlockHeight: number };
  try {
    blockhash = await withTimeout(input.blockhashRpc.getLatestBlockhash(), timeoutMs);
  } catch (error) {
    const reason = isTimeoutError(error)
      ? "blockhash request timed out"
      : "blockhash request failed";
    return unavailable(reason, genesis);
  }
  if (
    typeof blockhash.blockhash !== "string" ||
    blockhash.blockhash.trim() === "" ||
    !Number.isInteger(blockhash.lastValidBlockHeight) ||
    blockhash.lastValidBlockHeight < 0
  ) {
    return unavailable("blockhash response is missing expiry data", genesis);
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
    return unavailable("DevNet transfer could not be built", genesis);
  }
  const sealed = await sealPreparedTransfer({
    transaction,
    binding,
    bindingSha256,
    preparedAtMs: input.nowMs ?? Date.now(),
  });
  if (!sealed.ok) {
    return unavailable(sealed.reason, genesis);
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
  });
}

/**
 * Phantom is called only after every pre-check passes.
 * A mismatch clears readiness and the prepared state and does not call Phantom.
 * Blockhash expiry does not write a new blockhash onto the old prepared transfer.
 */
export async function signIfGated(input: SignInput): Promise<SignOutcome> {
  const timeoutMs = input.timeoutMs ?? RPC_TIMEOUT_MS;
  const current = input.session.prepared;
  if (input.candidate !== undefined && input.candidate !== current) {
    return { session: input.session, phantomCalled: false };
  }
  if (input.session.readiness !== "ready" || current === null) {
    return { session: input.session, phantomCalled: false };
  }
  const prepared = current;
  if (!connectedPhantom(input.wallet) || input.wallet.publicKey !== prepared.feePayer) {
    return {
      session: unavailable("wallet is not the prepared fee payer", input.session.genesis),
      phantomCalled: false,
    };
  }
  if (
    !formMatchesBinding({
      form: input.form,
      binding: prepared.binding,
      serializedTx: input.session.formSnapshot?.serializedTx ?? "",
    })
  ) {
    return {
      session: unavailable("form does not match the prepared transfer", input.session.genesis),
      phantomCalled: false,
    };
  }

  const genesis = await verifyAppDevnetGenesis(input.genesisRpc, timeoutMs);
  if (!genesis.ok) {
    return {
      session: unavailable(genesis.reason ?? "genesis freshness check failed", genesis),
      phantomCalled: false,
    };
  }

  const freshness = await blockhashStillValid(input.blockhashProbe, prepared, timeoutMs);
  if (!freshness.valid) {
    return {
      session: unavailable(freshness.reason, genesis),
      phantomCalled: false,
    };
  }

  const recheck = await preSignRecheck(prepared);
  if (!recheck.ok) {
    return {
      session: unavailable(recheck.reason, genesis),
      phantomCalled: false,
    };
  }
  const transaction = exactTransaction(prepared);
  if (!transaction || transaction !== recheck.transaction) {
    return {
      session: unavailable("exact prepared transaction is missing", genesis),
      phantomCalled: false,
    };
  }

  input.onReadiness?.("signing");
  let signedTransaction: Transaction;
  try {
    signedTransaction = await input.sign(transaction);
  } catch {
    return {
      session: failed("Phantom signTransaction was rejected", prepared, genesis, input.session.formSnapshot),
      phantomCalled: true,
    };
  }

  const after = await preSignRecheck(prepared);
  if (!after.ok) {
    return {
      session: failed("signed message does not match the prepared message", null, genesis, null),
      phantomCalled: true,
    };
  }
  let signedMessage: Uint8Array;
  try {
    signedMessage = signedTransaction.serializeMessage();
  } catch {
    return {
      session: failed("signed transaction message could not be read", null, genesis, null),
      phantomCalled: true,
    };
  }
  const signedHash = await sha256Bytes(signedMessage);
  if (signedHash !== prepared.messageSha256 || !bytesEqual(signedMessage, prepared.messageBytes)) {
    return {
      session: failed("signed message does not match the prepared message", null, genesis, null),
      phantomCalled: true,
    };
  }
  const signature = signedTransaction.signature;
  if (!signature || signature.byteLength !== 64) {
    return {
      session: failed("Phantom did not return a signature", prepared, genesis, input.session.formSnapshot),
      phantomCalled: true,
    };
  }
  let wire: Uint8Array;
  try {
    wire = copyBytes(
      signedTransaction.serialize({ requireAllSignatures: true, verifySignatures: false }),
    );
  } catch {
    return {
      session: failed("signed transaction bytes could not be read", prepared, genesis, input.session.formSnapshot),
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

function unavailable(note: string, genesis: LiveGenesisCheck | null): SigningSession {
  return sealSession({
    readiness: "unavailable",
    prepared: null,
    signed: null,
    genesis,
    note,
    formSnapshot: null,
  });
}

function failed(
  note: string,
  prepared: PreparedTransfer | null,
  genesis: LiveGenesisCheck | null,
  formSnapshot: TransferForm | null,
): SigningSession {
  return sealSession({
    readiness: "failed",
    prepared,
    signed: null,
    genesis,
    note,
    formSnapshot,
  });
}

function sealSession(session: SigningSession): SigningSession {
  return Object.freeze({
    readiness: session.readiness,
    prepared: session.prepared,
    signed: session.signed,
    genesis: session.genesis,
    note: session.note,
    formSnapshot: session.formSnapshot,
  });
}
