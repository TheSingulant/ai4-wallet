import { describe, expect, it } from "vitest";
import { decodeBase58 } from "../src/domain/address";
import { PHASE0_BOUNDARIES } from "../src/domain/boundaries";
import { evaluatePreview } from "../src/domain/evaluate";
import { devnetGuardReason, displayNetwork } from "../src/domain/devnetGuard";
import { checkDevnetGenesisHash, DEVNET_GENESIS_HASH } from "../src/domain/networkAuthority";
import { DISCONNECTED_WALLET, type SigningReadiness, type WalletSnapshot } from "../src/domain/types";
import {
  ALT_DESTINATION,
  CONSTRAINT_FIXTURES,
  DEVNET_TRANSFER,
  FIXTURE_DESTINATION,
} from "../src/fixtures/preview";
import { connectPhantom } from "../src/wallet/phantom";

const CONNECTED: WalletSnapshot = {
  status: "connected",
  publicKey: "FixturePublicKey",
  source: "phantom",
};

describe("DevNet guard", () => {
  it("accepts only devnet", () => {
    expect(devnetGuardReason("devnet")).toBeNull();
    expect(devnetGuardReason(" DevNet ")).toBeNull();
    expect(displayNetwork("devnet")).toBe("DevNet");
    expect(devnetGuardReason("mainnet-beta")).toMatch(/not devnet/);
    expect(devnetGuardReason("mainnet")).toMatch(/not devnet/);
    expect(devnetGuardReason("localnet")).toMatch(/not devnet/);
    expect(devnetGuardReason("testnet")).toMatch(/not devnet/);
    expect(devnetGuardReason("")).toMatch(/not devnet/);
  });

  it("fail closed on an attempted mainnet intent", async () => {
    const evaluation = await evaluatePreview({
      intent: { ...DEVNET_TRANSFER, network: "mainnet-beta" },
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: CONNECTED,
    });
    expect(evaluation.decision).toBe("DENY");
    expect(evaluation.constraintResult).toBeNull();
    expect(evaluation.signingReadiness).toBe("unavailable");
    expect(evaluation.reasons.some((reason) => reason.includes("mainnet-beta"))).toBe(true);
    expect(evaluation.approvedBinding).toBeNull();
    expect(evaluation.serializedTx).toBeNull();
    expect(evaluation.signingHandoff).toBeNull();
    expect(evaluation.networkDisplay).toBe("mainnet-beta");
    expect(PHASE0_BOUNDARIES.mainnetEnabled).toBe(false);
  });

  it("does not treat a provider cluster string or a public key as network authority", async () => {
    const session = await connectPhantom({
      getProvider: () => ({
        isPhantom: true,
        cluster: "mainnet-beta",
        connect: async () => ({ publicKey: { toString: () => "FixturePublicKey" } }),
      }),
    });
    expect(session).toEqual({
      status: "connected",
      publicKey: "FixturePublicKey",
      source: "phantom",
    });
    expect("network" in session).toBe(false);

    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: session,
    });
    expect(evaluation.constraintResult).toBe("ALLOW");
    expect(evaluation.decision).toBe("ALLOW");
    expect(evaluation.networkDisplay).toBe("DevNet");
    expect(evaluation.signingReadiness).toBe("not_ready");
    expect(evaluation.approvedBinding?.destination).toBe(FIXTURE_DESTINATION);
    expect(evaluation.signingHandoff).toBeNull();

    const otherKey = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: { ...CONNECTED, publicKey: "AnotherFixtureKey" },
    });
    expect(otherKey.decision).toBe("ALLOW");
    expect(otherKey.networkDisplay).toBe("DevNet");
    expect(otherKey.signingReadiness).not.toBe("ready");
  });

  it("keeps constraint ALLOW when the wallet session is missing", async () => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: DISCONNECTED_WALLET,
    });
    expect(evaluation.constraintResult).toBe("ALLOW");
    expect(evaluation.decision).toBe("ALLOW");
    expect(evaluation.signingReadiness).toBe("unavailable");
    expect(evaluation.reasons).toContain(
      "wallet is disconnected; signing readiness is unavailable",
    );
    expect(evaluation.approvedBinding).not.toBeNull();
  });
});

describe("genesis check stub", () => {
  it("names the DevNet genesis hash and does not call an RPC", () => {
    const check = checkDevnetGenesisHash();
    expect(check.expectedGenesisHash).toBe(DEVNET_GENESIS_HASH);
    expect(check.expectedGenesisHash).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    expect(check.observedGenesisHash).toBeNull();
    expect(check.checked).toBe(false);
    expect(check.liveRpc).toBe(false);
    expect(DEVNET_GENESIS_HASH).toHaveLength(44);
  });
});

describe("constraint fixtures", () => {
  it("shows ALLOW with a binding and unavailable signing readiness when the wallet is disconnected", async () => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: DISCONNECTED_WALLET,
    });
    expect(evaluation.wallet.status).toBe("disconnected");
    expect(evaluation.decision).toBe("ALLOW");
    expect(evaluation.constraintResult).toBe("ALLOW");
    expect(evaluation.signingReadiness).toBe("unavailable");
    expect(evaluation.reasons).toContain(
      "wallet is disconnected; signing readiness is unavailable",
    );
    expect(evaluation.approvedBinding?.destination).toBe(FIXTURE_DESTINATION);
    expect(evaluation.signingHandoff).toBeNull();
  });

  it("keeps connected ALLOW at not_ready", async () => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: CONNECTED,
    });
    expect(evaluation.constraintResult).toBe("ALLOW");
    expect(evaluation.decision).toBe("ALLOW");
    expect(evaluation.signingReadiness).toBe("not_ready");
    expect(evaluation.reasons).toContain("Phase 0 does not request signatures");
    expect(evaluation.signingHandoff).toBeNull();
  });

  it.each(["revise", "refuse"] as const)("%s carries no binding and unavailable readiness", async (name) => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES[name],
      wallet: CONNECTED,
    });
    expect(evaluation.constraintResult).toBe(CONSTRAINT_FIXTURES[name].decision);
    expect(evaluation.decision).toBe(CONSTRAINT_FIXTURES[name].decision);
    expect(evaluation.approvedBinding).toBeNull();
    expect(evaluation.serializedTx).toBeNull();
    expect(evaluation.signingHandoff).toBeNull();
    expect(evaluation.signingReadiness).toBe("unavailable");
    expect(evaluation.frozen).toBeNull();
  });

  it("rejects custody and server signing flags", async () => {
    const evaluation = await evaluatePreview({
      intent: {
        ...DEVNET_TRANSFER,
        requestCustody: true,
        serverSign: true,
        serverBroadcast: true,
      },
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: DISCONNECTED_WALLET,
    });
    expect(evaluation.decision).toBe("DENY");
    expect(evaluation.constraintResult).toBeNull();
    expect(evaluation.signingReadiness).toBe("unavailable");
    expect(evaluation.approvedBinding).toBeNull();
    expect(evaluation.signingHandoff).toBeNull();
    expect(evaluation.reasons).toEqual(
      expect.arrayContaining([
        "custody was requested; Phase 0 is non-custodial",
        "server signing was requested",
        "server broadcast was requested",
      ]),
    );
    expect(PHASE0_BOUNDARIES.serverSigning).toBe(false);
    expect(PHASE0_BOUNDARIES.liveSigningEnabled).toBe(false);
  });

  it("never reports signing readiness ready", async () => {
    const vocabulary: SigningReadiness[] = ["unavailable", "not_ready", "ready"];
    expect(vocabulary).toContain("ready");
    const cases = await Promise.all([
      evaluatePreview({
        intent: DEVNET_TRANSFER,
        constraint: CONSTRAINT_FIXTURES.allow,
        wallet: DISCONNECTED_WALLET,
      }),
      evaluatePreview({
        intent: DEVNET_TRANSFER,
        constraint: CONSTRAINT_FIXTURES.allow,
        wallet: CONNECTED,
      }),
      evaluatePreview({
        intent: DEVNET_TRANSFER,
        constraint: CONSTRAINT_FIXTURES.revise,
        wallet: CONNECTED,
      }),
      evaluatePreview({
        intent: DEVNET_TRANSFER,
        constraint: CONSTRAINT_FIXTURES.refuse,
        wallet: DISCONNECTED_WALLET,
      }),
      evaluatePreview({
        intent: { ...DEVNET_TRANSFER, network: "mainnet-beta" },
        constraint: CONSTRAINT_FIXTURES.allow,
        wallet: CONNECTED,
      }),
    ]);
    expect(cases.map((item) => item.signingReadiness)).not.toContain("ready");
    expect(PHASE0_BOUNDARIES.liveSigningEnabled).toBe(false);
  });
});

describe("addresses", () => {
  it("decodes the fixture destination and the system program id to 32 bytes", () => {
    expect(decodeBase58(FIXTURE_DESTINATION)).toHaveLength(32);
    const system = decodeBase58(ALT_DESTINATION);
    expect(system).toHaveLength(32);
    expect([...system].every((byte) => byte === 0)).toBe(true);
  });
});
