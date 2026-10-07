import type {
  Phase0SigningReadiness,
  ProductDecision,
  WalletSnapshot,
} from "./types";

export function sameWalletSession(left: WalletSnapshot, right: WalletSnapshot): boolean {
  return (
    left.status === right.status &&
    left.publicKey === right.publicKey &&
    left.source === right.source
  );
}

/**
 * Phase 0 readiness. The return type excludes ready.
 * A connected public key with ALLOW is not_ready because this phase does not
 * request a signature and does not bind exact message bytes.
 * A missing session, a non-ALLOW decision, or a changed session is unavailable.
 */
export function resolveSigningReadiness(input: {
  decision: ProductDecision;
  wallet: WalletSnapshot;
  sessionUnchanged: boolean;
}): Phase0SigningReadiness {
  if (input.decision !== "ALLOW" || !input.sessionUnchanged) {
    return "unavailable";
  }
  if (
    input.wallet.status !== "connected" ||
    input.wallet.publicKey === null ||
    input.wallet.publicKey.trim() === ""
  ) {
    return "unavailable";
  }
  return "not_ready";
}
