import type { Transaction } from "@solana/web3.js";
import type { WalletSnapshot } from "../domain/types";

/**
 * Wallet adapter boundary.
 * connect returns identity: connected or disconnected, a public key, and a source.
 * It does not choose the network.
 * signTransaction signs one previously prepared legacy transaction.
 * This interface has no send method.
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
  signTransaction(scope: WalletScope, transaction: Transaction): Promise<Transaction>;
}
