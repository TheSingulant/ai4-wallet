import { PRODUCT } from "../copy";
import type { LiveGenesisCheck } from "../domain/genesisLive";
import {
  preparedExpiresAtMs,
  type Phase1SigningReadiness,
  type SigningSession,
} from "../domain/signingSession";

export function genesisStatusLine(session: {
  readiness: Phase1SigningReadiness;
  genesis: LiveGenesisCheck | null;
}): string {
  if (session.readiness === "preparing") {
    return PRODUCT.genesisChecking;
  }
  if (session.genesis?.ok === true) {
    return PRODUCT.genesisVerified;
  }
  if (session.genesis === null) {
    return PRODUCT.genesisNotChecked;
  }
  return PRODUCT.genesisFailed;
}

export function phase1ReadinessLine(readiness: Phase1SigningReadiness): string {
  switch (readiness) {
    case "preparing":
      return PRODUCT.phase1Preparing;
    case "ready":
      return PRODUCT.phase1Ready;
    case "signing":
      return PRODUCT.phase1Signing;
    case "signed":
      return PRODUCT.phase1Signed;
    case "failed":
      return PRODUCT.phase1Failed;
    case "unavailable":
      return PRODUCT.phase1Unavailable;
  }
}

export function messageHashLine(session: SigningSession): string {
  if (!session.prepared) {
    return "Exact message binding: none.";
  }
  return `Exact message binding: ${session.prepared.messageSha256}`;
}

export function auditDigestLine(session: SigningSession): string {
  if (!session.prepared) {
    return "Intent binding: none.";
  }
  return `Intent binding: ${session.prepared.bindingSha256}. ${PRODUCT.auditNote}`;
}

export function expiryLine(session: SigningSession, nowMs: number): string {
  if (session.note === PRODUCT.preparedExpired) {
    return PRODUCT.preparedExpired;
  }
  const prepared = session.prepared;
  if (!prepared || (session.readiness !== "ready" && session.readiness !== "signing")) {
    return "Prepared transfer expiry: none.";
  }
  const remaining = preparedExpiresAtMs(prepared) - nowMs;
  if (remaining <= 0) {
    return "Prepared transfer expires in 0:00.";
  }
  return `Prepared transfer expires in ${formatRemaining(remaining)}.`;
}

function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
}

export function blockhashLine(session: SigningSession): string {
  if (!session.prepared) {
    return "Recent blockhash: none.";
  }
  return `Recent blockhash: ${session.prepared.blockhash}. Last valid block height: ${String(session.prepared.lastValidBlockHeight)}.`;
}

export function feePayerLine(session: SigningSession): string {
  if (!session.prepared) {
    return "Fee payer: the connected Phantom public key, once a transfer is prepared.";
  }
  return `Fee payer: ${session.prepared.feePayer}.`;
}

export function signedResultLine(session: SigningSession): string {
  if (!session.signed) {
    return "Signed result: none. Not broadcast.";
  }
  const signature = hex(session.signed.signature);
  return `Signature recorded locally: ${signature}. Signed transaction bytes held in memory (${String(session.signed.signedBytes.byteLength)}). Not broadcast.`;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
