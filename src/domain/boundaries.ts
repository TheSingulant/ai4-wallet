/**
 * Phase 0 evaluator locks.
 * liveSigningEnabled stays false: evaluatePreview does not request a signature.
 * Phase 1 local signing is a separate path and does not flip these flags.
 */
export const PHASE0_BOUNDARIES = {
  mainnetEnabled: false,
  privateKeyHandling: false,
  serverSigning: false,
  liveSigningEnabled: false,
  verifyProductionCalled: false,
  unsWrites: false,
  deployed: false,
} as const;

export type Phase0Boundaries = typeof PHASE0_BOUNDARIES;

/**
 * Phase 1 locks. A local Phantom signature can exist.
 * Broadcast, server signing, mainnet, production Verify, and UNS writes do not.
 */
export const PHASE1_BOUNDARIES = {
  mainnetEnabled: false,
  broadcastImplemented: false,
  signAndSendUsed: false,
  serverSigning: false,
  custody: false,
  verifyProductionCalled: false,
  unsWrites: false,
  deployed: false,
  transactionFormat: "legacy",
  phantomSignMethod: "signTransaction",
} as const;

export type Phase1Boundaries = typeof PHASE1_BOUNDARIES;
