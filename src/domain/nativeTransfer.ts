import { Message, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { decodeBase58 } from "./address";
import { bytesEqual, copyBytes, sha256Bytes } from "./canonical";
import { DEVNET_GENESIS_HASH } from "./networkAuthority";
import type { ApprovedBinding } from "./types";

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const SYSTEM_TRANSFER_INSTRUCTION = 2;

/**
 * Legacy Transaction.
 * A native SOL transfer is one system instruction and does not need address lookup tables.
 * The bytes Phantom is asked to sign are serializeMessage() on this object.
 */
export interface ExactTransferShape {
  readonly feePayer: string;
  readonly recipient: string;
  readonly lamports: number;
  readonly recentBlockhash: string;
  readonly programId: string;
  readonly numRequiredSignatures: number;
  readonly numReadonlySignedAccounts: number;
  readonly numReadonlyUnsignedAccounts: number;
  readonly accountKeys: readonly string[];
  readonly instructionAccounts: readonly string[];
}

export interface PreparedTransfer {
  readonly feePayer: string;
  readonly binding: Readonly<ApprovedBinding>;
  readonly bindingSha256: string;
  readonly messageBytes: Uint8Array;
  readonly messageSha256: string;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  readonly genesisHash: typeof DEVNET_GENESIS_HASH;
  readonly preparedAtMs: number;
}

const transactions = new WeakMap<PreparedTransfer, Transaction>();

/** A recent blockhash is 32 bytes once base58-decoded. Empty and other lengths fail closed. */
export function isExactBlockhash(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  try {
    return decodeBase58(value).byteLength === 32;
  } catch {
    return false;
  }
}

export function buildLegacySolTransfer(args: {
  feePayer: PublicKey;
  destination: PublicKey;
  lamports: number;
  blockhash: string;
  lastValidBlockHeight: number;
}): Transaction {
  if (!isExactBlockhash(args.blockhash)) {
    throw new Error("blockhash is not 32-byte base58");
  }
  const transaction = new Transaction({
    feePayer: args.feePayer,
    recentBlockhash: args.blockhash,
  });
  transaction.lastValidBlockHeight = args.lastValidBlockHeight;
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: args.feePayer,
      toPubkey: args.destination,
      lamports: args.lamports,
    }),
  );
  return transaction;
}

export function readSystemTransferMessage(
  transaction: Transaction,
): { ok: true; shape: ExactTransferShape } | { ok: false; reason: string } {
  let message;
  try {
    message = transaction.compileMessage();
  } catch {
    return { ok: false, reason: "transaction message could not be compiled" };
  }
  if (message.instructions.length !== 1) {
    return { ok: false, reason: "transaction does not contain exactly one instruction" };
  }
  const compiled = message.instructions[0];
  if (!compiled) {
    return { ok: false, reason: "transaction is missing an instruction" };
  }
  const programKey = message.accountKeys[compiled.programIdIndex];
  if (!programKey || programKey.toBase58() !== SYSTEM_PROGRAM_ID) {
    return { ok: false, reason: "instruction program id is not the system program" };
  }
  if (compiled.accounts.length !== 2) {
    return { ok: false, reason: "system transfer account metas are not source and recipient" };
  }
  const fromIndex = compiled.accounts[0];
  const toIndex = compiled.accounts[1];
  if (fromIndex === undefined || toIndex === undefined) {
    return { ok: false, reason: "system transfer account metas are incomplete" };
  }
  const from = message.accountKeys[fromIndex];
  const to = message.accountKeys[toIndex];
  if (!from || !to) {
    return { ok: false, reason: "system transfer accounts are missing" };
  }
  if (message.header.numRequiredSignatures !== 1) {
    return { ok: false, reason: "transaction does not require exactly one signature" };
  }
  if (message.header.numReadonlySignedAccounts !== 0) {
    return { ok: false, reason: "transaction readonly signed account flags are unexpected" };
  }
  if (message.header.numReadonlyUnsignedAccounts !== 1) {
    return { ok: false, reason: "transaction readonly unsigned account flags are unexpected" };
  }
  const feePayer = transaction.feePayer;
  if (!feePayer || !feePayer.equals(from) || !message.accountKeys[0]?.equals(feePayer)) {
    return { ok: false, reason: "fee payer is not the transfer source" };
  }
  if (transaction.recentBlockhash !== message.recentBlockhash) {
    return { ok: false, reason: "blockhash does not match the compiled message" };
  }
  if (!isExactBlockhash(message.recentBlockhash)) {
    return { ok: false, reason: "blockhash is not 32-byte base58" };
  }
  const lamports = decodeTransferLamports(compiled.data);
  if (lamports === null) {
    return { ok: false, reason: "instruction data is not a system transfer" };
  }
  const selfTransfer = from.equals(to);
  const actual = message.accountKeys.map((key) => key.toBase58());
  const expected = selfTransfer
    ? [from.toBase58(), SYSTEM_PROGRAM_ID]
    : [from.toBase58(), to.toBase58(), SYSTEM_PROGRAM_ID];
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return {
      ok: false,
      reason: selfTransfer
        ? "self-transfer account key ordering is not fee payer, system program"
        : "account key ordering is not fee payer, recipient, system program",
    };
  }
  if (selfTransfer) {
    if (fromIndex !== 0 || toIndex !== 0) {
      return { ok: false, reason: "self-transfer instruction accounts are not the fee payer" };
    }
  } else if (fromIndex !== 0 || toIndex !== 1) {
    return { ok: false, reason: "system transfer instruction accounts are not source then recipient" };
  }
  const programIndex = selfTransfer ? 1 : 2;
  if (compiled.programIdIndex !== programIndex || message.accountKeys[programIndex]?.toBase58() !== SYSTEM_PROGRAM_ID) {
    return { ok: false, reason: "system program is not the last account key" };
  }
  return {
    ok: true,
    shape: Object.freeze({
      feePayer: feePayer.toBase58(),
      recipient: to.toBase58(),
      lamports,
      recentBlockhash: message.recentBlockhash,
      programId: SYSTEM_PROGRAM_ID,
      numRequiredSignatures: message.header.numRequiredSignatures,
      numReadonlySignedAccounts: message.header.numReadonlySignedAccounts,
      numReadonlyUnsignedAccounts: message.header.numReadonlyUnsignedAccounts,
      accountKeys: Object.freeze(message.accountKeys.map((key) => key.toBase58())),
      instructionAccounts: Object.freeze([from.toBase58(), to.toBase58()]),
    }),
  };
}

export async function sealPreparedTransfer(args: {
  transaction: Transaction;
  binding: ApprovedBinding;
  bindingSha256: string;
  preparedAtMs: number;
}): Promise<
  | { ok: true; prepared: PreparedTransfer }
  | { ok: false; reason: string }
> {
  const shape = readSystemTransferMessage(args.transaction);
  if (!shape.ok) {
    return shape;
  }
  if (
    shape.shape.feePayer !== args.transaction.feePayer?.toBase58() ||
    shape.shape.recipient !== args.binding.destination ||
    shape.shape.lamports !== args.binding.lamports
  ) {
    return { ok: false, reason: "compiled transfer does not match the approved binding" };
  }
  const blockhash = args.transaction.recentBlockhash;
  const lastValidBlockHeight = args.transaction.lastValidBlockHeight;
  if (!isExactBlockhash(blockhash)) {
    return { ok: false, reason: "blockhash is not 32-byte base58" };
  }
  if (typeof lastValidBlockHeight !== "number" || !Number.isInteger(lastValidBlockHeight)) {
    return { ok: false, reason: "transaction is missing blockhash expiry data" };
  }
  let messageBytes: Uint8Array;
  try {
    messageBytes = args.transaction.serializeMessage();
  } catch {
    return { ok: false, reason: "transaction message could not be serialized" };
  }
  const stored = copyBytes(messageBytes);
  const messageSha256 = await sha256Bytes(stored);
  const binding = Object.freeze({
    network: args.binding.network,
    asset: args.binding.asset,
    action: args.binding.action,
    amount_sol: args.binding.amount_sol,
    lamports: args.binding.lamports,
    destination: args.binding.destination,
  });
  const prepared = Object.freeze({
    feePayer: shape.shape.feePayer,
    binding,
    bindingSha256: args.bindingSha256,
    get messageBytes(): Uint8Array {
      return copyBytes(stored);
    },
    messageSha256,
    blockhash,
    lastValidBlockHeight,
    genesisHash: DEVNET_GENESIS_HASH,
    preparedAtMs: args.preparedAtMs,
  });
  transactions.set(prepared, args.transaction);
  return { ok: true, prepared };
}

/** The Transaction instance that was sealed. Phantom is not given this shared object. */
export function exactTransaction(prepared: PreparedTransfer): Transaction | undefined {
  return transactions.get(prepared);
}

/**
 * Synchronous byte compare of the sealed transaction against the frozen message.
 * No digest await. A mismatch means the sealed object changed after prepare.
 */
export function preSignRecheck(
  prepared: PreparedTransfer,
): { ok: true; transaction: Transaction } | { ok: false; reason: string } {
  const transaction = transactions.get(prepared);
  if (!transaction) {
    return { ok: false, reason: "exact prepared transaction is missing" };
  }
  let serialized: Uint8Array;
  try {
    serialized = transaction.serializeMessage();
  } catch {
    return { ok: false, reason: "exact message could not be serialized" };
  }
  if (!bytesEqual(serialized, prepared.messageBytes) || !digestCorresponds(prepared)) {
    return { ok: false, reason: "exact message hash mismatch" };
  }
  return { ok: true, transaction };
}

export interface ExactSignCommit<T> {
  ok: true;
  pending: T;
}

export interface ExactSignRefusal {
  ok: false;
  reason: string;
}

/**
 * Synchronous pre-sign critical section.
 *
 * Invariant: this function does not await and does not invoke a readiness,
 * UI, or other external callback. It obtains the candidate Transaction,
 * calls serializeMessage() synchronously, and compares those bytes to the
 * frozen prepared message. Byte equality is correspondence with
 * `messageSha256`, because that digest was computed over these same sealed
 * bytes and the prepared record does not let either field change alone.
 * The next step is the sign call on that same candidate. Nothing in this
 * function runs between the comparison and `sign(candidate)`.
 *
 * The candidate is restored from the frozen message bytes so Phantom does
 * not receive the shared sealed instance. Restoration is accepted only when
 * its serializeMessage() equals those frozen bytes. The sealed instance must
 * still serialize to the same bytes; a mutated sealed object fails closed.
 */
export function commitExactMessageSign<T>(args: {
  prepared: PreparedTransfer;
  generation: { current: number };
  attemptGeneration: number;
  livePrepared: () => PreparedTransfer | null;
  formMatches: () => boolean;
  constraintAllows: () => boolean;
  providerPublicKey: () => string | null;
  walletPublicKey: () => string | null;
  sign: (transaction: Transaction) => T;
}): ExactSignCommit<T> | ExactSignRefusal {
  if (args.generation.current !== args.attemptGeneration || args.livePrepared() !== args.prepared) {
    return { ok: false, reason: "signing session was invalidated" };
  }
  if (!args.constraintAllows() || !args.formMatches()) {
    return { ok: false, reason: "form does not match the prepared transfer" };
  }
  let providerPublicKey: string | null;
  let walletPublicKey: string | null;
  try {
    providerPublicKey = args.providerPublicKey();
    walletPublicKey = args.walletPublicKey();
  } catch {
    return { ok: false, reason: "wallet is not the prepared fee payer" };
  }
  if (
    providerPublicKey === null ||
    walletPublicKey === null ||
    providerPublicKey !== args.prepared.feePayer ||
    walletPublicKey !== args.prepared.feePayer ||
    providerPublicKey !== walletPublicKey
  ) {
    return { ok: false, reason: "wallet is not the prepared fee payer" };
  }
  if (args.generation.current !== args.attemptGeneration || args.livePrepared() !== args.prepared) {
    return { ok: false, reason: "signing session was invalidated" };
  }
  const stored = transactions.get(args.prepared);
  if (!stored) {
    return { ok: false, reason: "exact prepared transaction is missing" };
  }
  const candidate = transactionFromFrozenMessage(args.prepared);
  if (!candidate) {
    return { ok: false, reason: "frozen message could not be restored" };
  }
  let candidateBytes: Uint8Array;
  let storedBytes: Uint8Array;
  try {
    candidateBytes = candidate.serializeMessage();
    storedBytes = stored.serializeMessage();
  } catch {
    return { ok: false, reason: "exact message could not be serialized" };
  }
  const frozen = args.prepared.messageBytes;
  if (
    !bytesEqual(candidateBytes, frozen) ||
    !bytesEqual(storedBytes, frozen) ||
    !digestCorresponds(args.prepared)
  ) {
    return { ok: false, reason: "exact message hash mismatch" };
  }
  const pending = args.sign(candidate);
  return { ok: true, pending };
}

function digestCorresponds(prepared: PreparedTransfer): boolean {
  return /^[0-9a-f]{64}$/.test(prepared.messageSha256) && prepared.messageBytes.byteLength > 0;
}

function transactionFromFrozenMessage(prepared: PreparedTransfer): Transaction | null {
  try {
    const transaction = Transaction.populate(Message.from(prepared.messageBytes));
    transaction.lastValidBlockHeight = prepared.lastValidBlockHeight;
    return transaction;
  } catch {
    return null;
  }
}

export async function verifyFeePayerSignature(
  transaction: Transaction,
  feePayer: string,
  message: Uint8Array,
): Promise<boolean> {
  const payer = publicKeyOrNull(feePayer);
  if (!payer || message.byteLength === 0) {
    return false;
  }
  const entry = transaction.signatures.find((sig) => sig.publicKey.equals(payer));
  if (!entry?.signature || entry.signature.byteLength !== 64) {
    return false;
  }
  const signature = bufferSource(entry.signature);
  const messageCopy = bufferSource(message);
  try {
    const key = await crypto.subtle.importKey("raw", bufferSource(payer.toBytes()), { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, messageCopy);
  } catch {
    return false;
  }
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function decodeTransferLamports(data: string): number | null {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase58(data);
  } catch {
    return null;
  }
  if (bytes.byteLength !== 12) {
    return null;
  }
  const copy = copyBytes(bytes);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const instruction = view.getUint32(0, true);
  if (instruction !== SYSTEM_TRANSFER_INSTRUCTION) {
    return null;
  }
  const lamports = view.getBigUint64(4, true);
  if (lamports <= 0n || lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(lamports);
}

export function publicKeyOrNull(value: string): PublicKey | null {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}
