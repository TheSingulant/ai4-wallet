import type { WalletSnapshot } from "../domain/types";

/**
 * Wallet adapter boundary.
 * Phase 0 implements Phantom detection and connect only.
 * connect returns identity: connected or disconnected, a public key, and a source.
 * It does not choose the preview network.
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
