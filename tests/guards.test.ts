import { describe, expect, it } from "vitest";
import { decodeBase58 } from "../src/domain/address";
import { PHASE0_BOUNDARIES } from "../src/domain/boundaries";
import { evaluatePreview } from "../src/domain/evaluate";
import { devnetGuardReason, displayNetwork } from "../src/domain/devnetGuard";
import { DISCONNECTED_WALLET, type WalletSnapshot } from "../src/domain/types";
import {
  ALT_DESTINATION,
  CONSTRAINT_FIXTURES,
  DEVNET_TRANSFER,
  FIXTURE_DESTINATION,
} from "../src/fixtures/preview";

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
      wallet: DISCONNECTED_WALLET,
    });
    expect(evaluation.decision).toBe("DENY");
    expect(evaluation.reasons.some((reason) => reason.includes("mainnet-beta"))).toBe(true);
    expect(evaluation.approvedBinding).toBeNull();
    expect(evaluation.serializedTx).toBeNull();
    expect(evaluation.signingHandoff).toBeNull();
    expect(evaluation.networkDisplay).toBe("mainnet-beta");
    expect(PHASE0_BOUNDARIES.mainnetEnabled).toBe(false);
  });

  it("fail closed when a connected wallet reports the wrong cluster", async () => {
    const wallet: WalletSnapshot = {
      status: "connected",
      publicKey: "FixturePublicKey",
      network: "mainnet-beta",
      source: "phantom",
    };
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet,
    });
    expect(evaluation.decision).toBe("DENY");
    expect(evaluation.reasons).toContain("wallet cluster is not devnet; fail closed");
    expect(evaluation.approvedBinding).toBeNull();
    expect(evaluation.signingHandoff).toBeNull();
    expect(evaluation.walletNetworkDisplay).toBe("mainnet-beta");
  });

  it("fail closed when the wallet connects without a cluster", async () => {
    const wallet: WalletSnapshot = {
      status: "connected",
      publicKey: "FixturePublicKey",
      network: null,
      source: "phantom",
    };
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet,
    });
    expect(evaluation.decision).toBe("DENY");
    expect(evaluation.approvedBinding).toBeNull();
    expect(evaluation.signingHandoff).toBeNull();
  });
});

describe("constraint fixtures", () => {
  it("shows ALLOW with a binding and no signing handoff when the wallet is disconnected", async () => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: DISCONNECTED_WALLET,
    });
    expect(evaluation.wallet.status).toBe("disconnected");
    expect(evaluation.decision).toBe("ALLOW");
    expect(evaluation.reasons).toContain("wallet is disconnected; signing handoff is not available");
    expect(evaluation.approvedBinding?.destination).toBe(FIXTURE_DESTINATION);
    expect(evaluation.signingHandoff).toBeNull();
  });

  it.each(["revise", "refuse"] as const)("%s carries no binding and no signing handoff", async (name) => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES[name],
      wallet: DISCONNECTED_WALLET,
    });
    expect(evaluation.decision).toBe(CONSTRAINT_FIXTURES[name].decision);
    expect(evaluation.approvedBinding).toBeNull();
    expect(evaluation.serializedTx).toBeNull();
    expect(evaluation.signingHandoff).toBeNull();
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
});

describe("addresses", () => {
  it("decodes the fixture destination and the system program id to 32 bytes", () => {
    expect(decodeBase58(FIXTURE_DESTINATION)).toHaveLength(32);
    const system = decodeBase58(ALT_DESTINATION);
    expect(system).toHaveLength(32);
    expect([...system].every((byte) => byte === 0)).toBe(true);
  });
});
