import { DEVNET_GENESIS_HASH } from "./networkAuthority";
import { isTimeoutError, withTimeout } from "./timeout";

/** App-owned DevNet RPC. The wallet does not choose this endpoint. */
export const APP_DEVNET_RPC_URL = "https://api.devnet.solana.com";

/** Bound for genesis and blockhash RPC calls. A hang is a failed check. */
export const RPC_TIMEOUT_MS = 8_000;

export interface GenesisRpc {
  getGenesisHash(): Promise<string>;
}

export interface LiveGenesisCheck {
  readonly ok: boolean;
  readonly expectedGenesisHash: typeof DEVNET_GENESIS_HASH;
  readonly observedGenesisHash: string | null;
  readonly checked: boolean;
  readonly liveRpc: true;
  readonly reason: string | null;
}

/**
 * Live DevNet genesis check.
 * Fail closed on mismatch, a missing hash, a fetch error, or a timeout.
 * This does not replace checkDevnetGenesisHash(), which stays a pure stub.
 */
export async function verifyAppDevnetGenesis(
  rpc: GenesisRpc,
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<LiveGenesisCheck> {
  let observed: string;
  try {
    observed = await withTimeout(rpc.getGenesisHash(), timeoutMs);
  } catch (error) {
    const reason = isTimeoutError(error)
      ? "genesis hash request timed out"
      : "genesis hash request failed";
    return freezeCheck({
      ok: false,
      observedGenesisHash: null,
      checked: false,
      reason,
    });
  }
  if (typeof observed !== "string" || observed.trim() === "") {
    return freezeCheck({
      ok: false,
      observedGenesisHash: typeof observed === "string" ? observed : null,
      checked: true,
      reason: "genesis hash is missing",
    });
  }
  if (observed !== DEVNET_GENESIS_HASH) {
    return freezeCheck({
      ok: false,
      observedGenesisHash: observed,
      checked: true,
      reason: "genesis hash is not DevNet",
    });
  }
  return freezeCheck({
    ok: true,
    observedGenesisHash: observed,
    checked: true,
    reason: null,
  });
}

function freezeCheck(args: {
  ok: boolean;
  observedGenesisHash: string | null;
  checked: boolean;
  reason: string | null;
}): LiveGenesisCheck {
  return Object.freeze({
    ok: args.ok,
    expectedGenesisHash: DEVNET_GENESIS_HASH,
    observedGenesisHash: args.observedGenesisHash,
    checked: args.checked,
    liveRpc: true,
    reason: args.reason,
  });
}
