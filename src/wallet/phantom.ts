import type { Transaction } from "@solana/web3.js";
import { DISCONNECTED_WALLET, type WalletSnapshot } from "../domain/types";
import type { WalletAdapter, WalletDetection, WalletScope } from "./types";

interface PublicKeyLike {
  toString(): string;
}

interface PhantomProvider {
  isPhantom?: boolean;
  connect: () => Promise<{ publicKey?: PublicKeyLike | null }>;
}

function readProvider(value: unknown): PhantomProvider | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as PhantomProvider;
  if (record.isPhantom !== true || typeof record.connect !== "function") {
    return null;
  }
  return record;
}

export function detectPhantom(scope: WalletScope): WalletDetection {
  const provider = readProvider(scope.getProvider("phantom"));
  return { adapterId: "phantom", present: provider !== null };
}

interface PhantomSigner {
  signTransaction(transaction: Transaction): Promise<Transaction>;
}

function readSigner(value: unknown): PhantomSigner | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as {
    isPhantom?: boolean;
    signTransaction?: (transaction: Transaction) => Promise<Transaction>;
  };
  if (record.isPhantom !== true || typeof record.signTransaction !== "function") {
    return null;
  }
  const signTransaction = record.signTransaction.bind(record);
  return { signTransaction };
}

/**
 * The only Phantom signature call in this repository.
 * It signs the transaction it is given. It does not send that transaction.
 */
export async function signTransaction(
  scope: WalletScope,
  transaction: Transaction,
): Promise<Transaction> {
  const signer = readSigner(scope.getProvider("phantom"));
  if (!signer) {
    throw new Error("Phantom signTransaction is unavailable");
  }
  return signer.signTransaction(transaction);
}

export async function connectPhantom(scope: WalletScope): Promise<WalletSnapshot> {
  const provider = readProvider(scope.getProvider("phantom"));
  if (!provider) {
    return DISCONNECTED_WALLET;
  }
  try {
    const result = await provider.connect();
    const publicKey = result.publicKey?.toString() ?? "";
    if (publicKey.trim() === "") {
      return DISCONNECTED_WALLET;
    }
    return Object.freeze({
      status: "connected",
      publicKey,
      source: "phantom",
    });
  } catch {
    return DISCONNECTED_WALLET;
  }
}

export const phantomAdapter: WalletAdapter = {
  id: "phantom",
  chainFamily: "solana",
  detect: detectPhantom,
  connect: connectPhantom,
  signTransaction,
};

export function browserWalletScope(): WalletScope {
  return {
    getProvider(adapterId: string): unknown {
      if (adapterId !== "phantom" || typeof window === "undefined") {
        return undefined;
      }
      const host = window as Window & {
        phantom?: { solana?: unknown };
      };
      return host.phantom?.solana;
    },
  };
}

export function listAdapters(): readonly WalletAdapter[] {
  return [phantomAdapter];
}
