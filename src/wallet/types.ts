import type { WalletSnapshot } from "../domain/types";

/**
 * Wallet adapter boundary.
 * Phase 0 implements Phantom detection and connect only.
 * A later adapter can use the same shape for another transport or chain family.
 * This interface has no sign method and no send method.
 */
export interface WalletScope {
  getProvider(adapterId: string): unknown;
}

export interface WalletDetection {
  adapterId: string;
  present: boolean;
}

export interface WalletAdapter {
  readonly id: string;
  readonly chainFamily: "solana" | "evm";
  detect(scope: WalletScope): WalletDetection;
  connect(scope: WalletScope): Promise<WalletSnapshot>;
}
