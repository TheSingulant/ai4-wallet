/**
 * Phase 0 product locks. These flags describe the scaffold.
 * Live signing, server signing, production Verify, and UNS writes are absent.
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
