/**
 * Domain types aligned with ai4.transaction NormalizedIntent and ApprovedBinding.
 * Field names match the Python canonical payload so the sha256 is comparable.
 */

export const REQUIRED_NETWORK = "devnet" as const;
export const PHASE0_ASSET = "SOL" as const;
export const PHASE0_ACTION = "transfer" as const;

/** Phase 0 proof cap, aligned with the DevNet E2E cap in ai4-constrain. */
export const PHASE0_MAX_SOL = "0.01";

export type ConstraintDecision = "ALLOW" | "REVISE" | "REFUSE";
export type ProductDecision = ConstraintDecision | "DENY";

export interface TransferIntentInput {
  network: string;
  asset: string;
  action: string;
  amount: string;
  destination: string;
  requestCustody?: boolean;
  serverSign?: boolean;
  serverBroadcast?: boolean;
}

export interface NormalizedIntent {
  network: typeof REQUIRED_NETWORK;
  asset: typeof PHASE0_ASSET;
  action: typeof PHASE0_ACTION;
  amount_sol: string;
  lamports: number;
  destination: string;
}

/**
 * Structured params bound at ALLOW time.
 * Canonical JSON uses these keys, sorted, with compact separators.
 */
export interface ApprovedBinding {
  network: string;
  asset: string;
  action: string;
  amount_sol: string;
  lamports: number;
  destination: string;
}

export interface FrozenAllow {
  binding: ApprovedBinding;
  sha256: string;
  serializedTx: string;
  serializedTxSha256: string;
}

export interface WalletSnapshot {
  status: "disconnected" | "connected";
  publicKey: string | null;
  network: string | null;
  source: "none" | "phantom" | "simulation";
}

export interface ConstraintFixture {
  id: string;
  decision: ConstraintDecision;
  reasons: readonly string[];
}

export const DISCONNECTED_WALLET: WalletSnapshot = {
  status: "disconnected",
  publicKey: null,
  network: null,
  source: "none",
};
