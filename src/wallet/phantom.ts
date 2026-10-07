import { DISCONNECTED_WALLET, type WalletSnapshot } from "../domain/types";
import type { WalletAdapter, WalletDetection, WalletScope } from "./types";

interface PublicKeyLike {
  toString(): string;
}

interface PhantomProvider {
  isPhantom?: boolean;
  cluster?: string;
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

export async function connectPhantom(scope: WalletScope): Promise<WalletSnapshot> {
  const provider = readProvider(scope.getProvider("phantom"));
  if (!provider) {
    return {
      ...DISCONNECTED_WALLET,
    };
  }
  try {
    const result = await provider.connect();
    const publicKey = result.publicKey?.toString() ?? "";
    if (publicKey.trim() === "") {
      return { ...DISCONNECTED_WALLET };
    }
    const network = typeof provider.cluster === "string" ? provider.cluster : null;
    return {
      status: "connected",
      publicKey,
      network,
      source: "phantom",
    };
  } catch {
    return { ...DISCONNECTED_WALLET };
  }
}

export const phantomAdapter: WalletAdapter = {
  id: "phantom",
  chainFamily: "solana",
  detect: detectPhantom,
  connect: connectPhantom,
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
