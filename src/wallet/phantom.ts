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
 * The provider is invoked before this function returns a promise.
 * It signs the transaction it is given. It does not send that transaction.
 */
export function signTransaction(
  scope: WalletScope,
  transaction: Transaction,
): Promise<Transaction> {
  const signer = readSigner(scope.getProvider("phantom"));
  if (!signer) {
    return Promise.reject(new Error("Phantom signTransaction is unavailable"));
  }
  return signer.signTransaction(transaction);
}

export function readPhantomPublicKey(scope: WalletScope): string | null {
  const provider = scope.getProvider("phantom");
  if (typeof provider !== "object" || provider === null) {
    return null;
  }
  const record = provider as { isPhantom?: boolean; publicKey?: { toString(): string } | string | null };
  if (record.isPhantom !== true) {
    return null;
  }
  return publicKeyText(record.publicKey);
}

export interface PhantomSessionHandlers {
  onAccountChanged: (publicKey: string | null) => void;
  onDisconnect: () => void;
}

/**
 * Subscribe to Phantom account changes and disconnect.
 * The returned function removes those listeners.
 */
export function subscribePhantomSession(scope: WalletScope, handlers: PhantomSessionHandlers): () => void {
  const provider = scope.getProvider("phantom");
  if (typeof provider !== "object" || provider === null) {
    return () => undefined;
  }
  const record = provider as PhantomEventProvider;
  if (record.isPhantom !== true || typeof record.on !== "function") {
    return () => undefined;
  }
  const onAccount = (publicKey: unknown) => {
    handlers.onAccountChanged(publicKeyText(publicKey));
  };
  const onDisconnect = () => {
    handlers.onDisconnect();
  };
  record.on("accountChanged", onAccount);
  record.on("disconnect", onDisconnect);
  return () => {
    unlisten(record, "accountChanged", onAccount);
    unlisten(record, "disconnect", onDisconnect);
  };
}

interface PhantomEventProvider {
  isPhantom?: boolean;
  on?: (event: string, handler: (value?: unknown) => void) => void;
  off?: (event: string, handler: (value?: unknown) => void) => void;
  removeListener?: (event: string, handler: (value?: unknown) => void) => void;
}

function unlisten(
  record: PhantomEventProvider,
  event: string,
  handler: (value?: unknown) => void,
): void {
  if (typeof record.off === "function") {
    record.off(event, handler);
    return;
  }
  if (typeof record.removeListener === "function") {
    record.removeListener(event, handler);
  }
}

function publicKeyText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() === "" ? null : value;
  }
  if (typeof value === "object" && value !== null && "toString" in value) {
    const text = (value as { toString(): string }).toString();
    return typeof text === "string" && text.trim() !== "" ? text : null;
  }
  return null;
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
