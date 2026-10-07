import { DISCONNECTED_WALLET, type WalletSnapshot } from "../domain/types";
import { subscribePhantomSession } from "../wallet/phantom";
import type { WalletScope } from "../wallet/types";

export const WALLET_SESSION_CHANGED = "wallet session changed; signing readiness is unavailable";

export interface PhantomIdentityBinding {
  /** Replace any previous listeners, then subscribe once. */
  bind(): void;
  /** Remove the current listeners. */
  unbind(): void;
}

/**
 * The Phantom accountChanged and disconnect wiring used by the page.
 * Rebinding removes the previous listeners before adding new ones.
 */
export function createPhantomIdentityBinding(args: {
  scope: WalletScope;
  getWallet: () => WalletSnapshot;
  setWallet: (wallet: WalletSnapshot) => void;
  setConnectNote: (note: string) => void;
  drop: (note: string) => void;
  afterChange?: () => void;
}): PhantomIdentityBinding {
  let unsubscribe: () => void = () => undefined;
  function apply(publicKey: string | null, note: string): void {
    const next: WalletSnapshot =
      publicKey === null
        ? DISCONNECTED_WALLET
        : Object.freeze({
            status: "connected",
            publicKey,
            source: "phantom",
          });
    const current = args.getWallet();
    if (next.status === current.status && next.publicKey === current.publicKey && next.source === current.source) {
      return;
    }
    args.setWallet(next);
    args.setConnectNote(note);
    args.drop(WALLET_SESSION_CHANGED);
    args.afterChange?.();
  }
  return {
    bind() {
      unsubscribe();
      unsubscribe = subscribePhantomSession(args.scope, {
        onAccountChanged: (publicKey) => {
          apply(publicKey, "Phantom account changed. Signing readiness is unavailable.");
        },
        onDisconnect: () => {
          apply(null, "Wallet disconnected. Signing readiness is unavailable.");
        },
      });
    },
    unbind() {
      unsubscribe();
      unsubscribe = () => undefined;
    },
  };
}
