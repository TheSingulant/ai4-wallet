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

/**
 * Signing readiness is not a constraint result.
 * Phase 0 can return unavailable or not_ready. It cannot return ready.
 */
export type SigningReadiness = "unavailable" | "not_ready" | "ready";
export type Phase0SigningReadiness = Exclude<SigningReadiness, "ready">;

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
  readonly network: typeof REQUIRED_NETWORK;
  readonly asset: typeof PHASE0_ASSET;
  readonly action: typeof PHASE0_ACTION;
  readonly amount_sol: string;
  readonly lamports: number;
  readonly destination: string;
}

/**
 * Six-field audit binding. SHA-256 of canonical JSON matches ai4-constrain.
 * That digest is not sufficient to authorize a future signature.
 * Phase 1 must extend the approval with a hash of the exact message bytes.
 * See docs/architecture.md.
 */
export interface ApprovedBinding {
  network: string;
  asset: string;
  action: string;
  amount_sol: string;
  lamports: number;
  destination: string;
}

/** Form fields captured at ALLOW. This object is frozen with the snapshot. */
export interface ApprovedFormState {
  readonly amount: string;
  readonly destination: string;
  readonly network: string;
  readonly serializedTx: string;
}

/**
 * Identity only. A public key is not a network, and this snapshot has no cluster.
 */
export interface WalletSnapshot {
  readonly status: "disconnected" | "connected";
  readonly publicKey: string | null;
  readonly source: "none" | "phantom" | "simulation";
}

export interface FrozenAllow {
  readonly binding: Readonly<ApprovedBinding>;
  readonly sha256: string;
  readonly serializedTx: string;
  readonly serializedTxSha256: string;
  readonly approvedForm: ApprovedFormState;
  readonly session: WalletSnapshot;
}

export interface ConstraintFixture {
  id: string;
  decision: ConstraintDecision;
  reasons: readonly string[];
}

export const DISCONNECTED_WALLET: WalletSnapshot = Object.freeze({
  status: "disconnected",
  publicKey: null,
  source: "none",
});
