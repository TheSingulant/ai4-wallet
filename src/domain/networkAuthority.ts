/**
 * Phase 0 network authority is the local DevNet preview configuration.
 * Wallet identity does not choose the network.
 *
 * Phase 1 network authority is the application RPC endpoint together with
 * transaction construction. Before any live transaction is constructed,
 * getGenesisHash() must equal DEVNET_GENESIS_HASH. This module does not
 * perform that call.
 */
export const DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" as const;

export const PREVIEW_NETWORK = Object.freeze({
  name: "devnet" as const,
  authority: "app_preview_config" as const,
});

export interface GenesisHashCheck {
  readonly expectedGenesisHash: typeof DEVNET_GENESIS_HASH;
  readonly observedGenesisHash: null;
  readonly checked: false;
  readonly liveRpc: false;
}

/** Pure stub. No RPC client and no network call. */
export function checkDevnetGenesisHash(): GenesisHashCheck {
  return Object.freeze({
    expectedGenesisHash: DEVNET_GENESIS_HASH,
    observedGenesisHash: null,
    checked: false,
    liveRpc: false,
  });
}
