import { describe, expect, it } from "vitest";
import { PHASE0_BOUNDARIES } from "../src/domain/boundaries";
import { verifyAppDevnetGenesis } from "../src/domain/genesisLive";
import { checkDevnetGenesisHash, DEVNET_GENESIS_HASH } from "../src/domain/networkAuthority";
import { runPrepare } from "../src/domain/signingSession";
import { createAppDevnetConnection } from "../src/solana/devnetConnection";
import { APP_DEVNET_RPC_URL } from "../src/domain/genesisLive";
import { allowEvaluation, BLOCKHASH_A, blockhashRpc, formFrom, genesisRpc, PHANTOM_WALLET } from "./phase1/helpers";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

describe("DevNet genesis authority", () => {
  it("keeps the Phase 0 stub from calling an RPC", () => {
    const check = checkDevnetGenesisHash();
    expect(check.expectedGenesisHash).toBe(DEVNET_GENESIS_HASH);
    expect(check.observedGenesisHash).toBeNull();
    expect(check.checked).toBe(false);
    expect(check.liveRpc).toBe(false);
    expect(PHASE0_BOUNDARIES.mainnetEnabled).toBe(false);
  });

  it("owns the network through the explicit DevNet RPC", () => {
    expect(APP_DEVNET_RPC_URL).toBe("https://api.devnet.solana.com");
    const connection = createAppDevnetConnection();
    expect(connection.rpcEndpoint).toBe(APP_DEVNET_RPC_URL);
    expect(connection.rpcEndpoint).not.toMatch(/mainnet/i);
  });

  it("accepts only the DevNet genesis hash", async () => {
    const check = await verifyAppDevnetGenesis({
      getGenesisHash: async () => DEVNET_GENESIS_HASH,
    });
    expect(check.ok).toBe(true);
    expect(check.checked).toBe(true);
    expect(check.liveRpc).toBe(true);
    expect(check.observedGenesisHash).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    expect(check.reason).toBeNull();
  });

  it("fail closed when the genesis hash is mainnet", async () => {
    const check = await verifyAppDevnetGenesis({
      getGenesisHash: async () => MAINNET_GENESIS,
    });
    expect(check.ok).toBe(false);
    expect(check.checked).toBe(true);
    expect(check.observedGenesisHash).toBe(MAINNET_GENESIS);
    expect(check.reason).toMatch(/not DevNet/);
  });

  it.each(["", "   "])("fail closed when the genesis hash is missing (%j)", async (observed) => {
    const check = await verifyAppDevnetGenesis({
      getGenesisHash: async () => observed,
    });
    expect(check.ok).toBe(false);
    expect(check.checked).toBe(true);
    expect(check.reason).toMatch(/missing/);
  });

  it("fail closed when the genesis fetch throws", async () => {
    const check = await verifyAppDevnetGenesis({
      getGenesisHash: async () => {
        throw new Error("network down");
      },
    });
    expect(check.ok).toBe(false);
    expect(check.checked).toBe(false);
    expect(check.observedGenesisHash).toBeNull();
    expect(check.reason).toMatch(/failed/);
  });

  it("fail closed when the genesis fetch times out", async () => {
    const check = await verifyAppDevnetGenesis(
      { getGenesisHash: () => new Promise(() => undefined) },
      20,
    );
    expect(check.ok).toBe(false);
    expect(check.checked).toBe(false);
    expect(check.reason).toMatch(/timed out/);
  });

  it("does not build a transaction when genesis does not match", async () => {
    const evaluation = await allowEvaluation();
    const genesis = genesisRpc(MAINNET_GENESIS);
    const blockhash = blockhashRpc();
    const session = await runPrepare({
      decision: evaluation.decision,
      constraintResult: evaluation.constraintResult,
      binding: evaluation.approvedBinding,
      bindingSha256: evaluation.approvedBinding?.sha256 ?? null,
      serializedTx: evaluation.serializedTx,
      wallet: PHANTOM_WALLET,
      form: formFrom(evaluation),
      genesisRpc: genesis.rpc,
      blockhashRpc: blockhash.rpc,
      timeoutMs: 50,
    });
    expect(genesis.calls).toEqual(["genesis"]);
    expect(blockhash.calls).toEqual([]);
    expect(session.readiness).toBe("unavailable");
    expect(session.prepared).toBeNull();
    expect(session.genesis?.ok).toBe(false);
  });

  it("checks genesis before requesting a blockhash", async () => {
    const evaluation = await allowEvaluation();
    const order: string[] = [];
    const session = await runPrepare({
      decision: evaluation.decision,
      constraintResult: evaluation.constraintResult,
      binding: evaluation.approvedBinding,
      bindingSha256: evaluation.approvedBinding?.sha256 ?? null,
      serializedTx: evaluation.serializedTx,
      wallet: PHANTOM_WALLET,
      form: formFrom(evaluation),
      genesisRpc: {
        async getGenesisHash() {
          order.push("genesis");
          return DEVNET_GENESIS_HASH;
        },
      },
      blockhashRpc: {
        async getLatestBlockhash() {
          order.push("blockhash");
          return { blockhash: BLOCKHASH_A, lastValidBlockHeight: 100 };
        },
      },
      timeoutMs: 50,
    });
    expect(order).toEqual(["genesis", "blockhash"]);
    expect(session.readiness).toBe("ready");
    expect(session.prepared).not.toBeNull();
  });
});
