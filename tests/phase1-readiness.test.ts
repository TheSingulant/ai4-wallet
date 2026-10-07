import { describe, expect, it } from "vitest";
import { PHASE0_BOUNDARIES } from "../src/domain/boundaries";
import { evaluatePreview } from "../src/domain/evaluate";
import { resolveSigningReadiness } from "../src/domain/signingReadiness";
import {
  derivePhase1Readiness,
  invalidateSigningSession,
  runPrepare,
} from "../src/domain/signingSession";
import { DISCONNECTED_WALLET } from "../src/domain/types";
import {
  ALT_DESTINATION,
  CONSTRAINT_FIXTURES,
  DEVNET_TRANSFER,
} from "../src/fixtures/preview";
import {
  allowEvaluation,
  blockhashRpc,
  formFrom,
  genesisRpc,
  PHANTOM_WALLET,
  preparedAllow,
  walletWith,
} from "./phase1/helpers";

const base = {
  status: "idle" as const,
  connected: true,
  genesisOk: true,
  allow: true,
  bindingValid: true,
  messageBuilt: true,
  messageHashStored: true,
  formMatches: true,
};

describe("constraint and signing readiness stay separate", () => {
  it("treats ALLOW as not ready until the exact message exists", () => {
    expect(derivePhase1Readiness({ ...base, messageBuilt: false, messageHashStored: false })).toBe(
      "unavailable",
    );
    expect(derivePhase1Readiness({ ...base, allow: false })).toBe("unavailable");
    expect(derivePhase1Readiness({ ...base, genesisOk: false })).toBe("unavailable");
    expect(derivePhase1Readiness({ ...base, connected: false })).toBe("unavailable");
    expect(derivePhase1Readiness({ ...base, formMatches: false })).toBe("unavailable");
    expect(derivePhase1Readiness(base)).toBe("ready");
    expect(derivePhase1Readiness({ ...base, status: "preparing", messageBuilt: false })).toBe(
      "preparing",
    );
    expect(derivePhase1Readiness({ ...base, status: "signing" })).toBe("signing");
    expect(derivePhase1Readiness({ ...base, status: "signed" })).toBe("signed");
    expect(derivePhase1Readiness({ ...base, status: "signed", formMatches: false })).toBe(
      "unavailable",
    );
    expect(derivePhase1Readiness({ ...base, status: "failed" })).toBe("failed");
  });

  it("keeps the Phase 0 evaluator off ready", async () => {
    const disconnected = await allowEvaluation(DISCONNECTED_WALLET);
    const connected = await allowEvaluation(PHANTOM_WALLET);
    expect(disconnected.constraintResult).toBe("ALLOW");
    expect(disconnected.signingReadiness).toBe("unavailable");
    expect(connected.constraintResult).toBe("ALLOW");
    expect(connected.signingReadiness).toBe("not_ready");
    expect(resolveSigningReadiness({
      decision: "ALLOW",
      wallet: PHANTOM_WALLET,
      sessionUnchanged: true,
    })).toBe("not_ready");
    expect(PHASE0_BOUNDARIES.liveSigningEnabled).toBe(false);
  });

  it("stays unavailable for a disconnected ALLOW until a Phantom identity is connected", async () => {
    const evaluation = await allowEvaluation(DISCONNECTED_WALLET);
    const genesis = genesisRpc();
    const blockhash = blockhashRpc();
    const session = await runPrepare({
      decision: evaluation.decision,
      constraintResult: evaluation.constraintResult,
      binding: evaluation.approvedBinding,
      bindingSha256: evaluation.approvedBinding?.sha256 ?? null,
      serializedTx: evaluation.serializedTx,
      wallet: DISCONNECTED_WALLET,
      form: formFrom(evaluation),
      genesisRpc: genesis.rpc,
      blockhashRpc: blockhash.rpc,
    });
    expect(evaluation.signingReadiness).toBe("unavailable");
    expect(session.readiness).toBe("unavailable");
    expect(session.prepared).toBeNull();
    expect(genesis.calls).toEqual([]);
    expect(blockhash.calls).toEqual([]);
  });

  it.each(["revise", "refuse"] as const)("does not prepare on %s", async (name) => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES[name],
      wallet: PHANTOM_WALLET,
    });
    const blockhash = blockhashRpc();
    const session = await runPrepare({
      decision: evaluation.decision,
      constraintResult: evaluation.constraintResult,
      binding: evaluation.approvedBinding,
      bindingSha256: null,
      serializedTx: evaluation.serializedTx,
      wallet: PHANTOM_WALLET,
      form: formFrom(evaluation),
      genesisRpc: genesisRpc().rpc,
      blockhashRpc: blockhash.rpc,
    });
    expect(evaluation.signingReadiness).toBe("unavailable");
    expect(evaluation.approvedBinding).toBeNull();
    expect(session.readiness).toBe("unavailable");
    expect(session.prepared).toBeNull();
    expect(blockhash.calls).toEqual([]);
  });

  it("does not prepare a mainnet intent", async () => {
    const evaluation = await evaluatePreview({
      intent: { ...DEVNET_TRANSFER, network: "mainnet-beta" },
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: PHANTOM_WALLET,
    });
    const blockhash = blockhashRpc();
    const session = await runPrepare({
      decision: evaluation.decision,
      constraintResult: evaluation.constraintResult,
      binding: null,
      bindingSha256: null,
      serializedTx: null,
      wallet: PHANTOM_WALLET,
      form: {
        amount: "0.001",
        destination: DEVNET_TRANSFER.destination,
        network: "mainnet-beta",
        serializedTx: "",
      },
      genesisRpc: genesisRpc().rpc,
      blockhashRpc: blockhash.rpc,
    });
    expect(evaluation.decision).toBe("DENY");
    expect(evaluation.signingReadiness).toBe("unavailable");
    expect(session.readiness).toBe("unavailable");
    expect(blockhash.calls).toEqual([]);
  });

  it("drops to unavailable when the form no longer matches", async () => {
    const evaluation = await allowEvaluation();
    const blockhash = blockhashRpc();
    const session = await runPrepare({
      decision: evaluation.decision,
      constraintResult: evaluation.constraintResult,
      binding: evaluation.approvedBinding,
      bindingSha256: evaluation.approvedBinding?.sha256 ?? null,
      serializedTx: evaluation.serializedTx,
      wallet: PHANTOM_WALLET,
      form: formFrom(evaluation, { destination: ALT_DESTINATION }),
      genesisRpc: genesisRpc().rpc,
      blockhashRpc: blockhash.rpc,
    });
    expect(evaluation.constraintResult).toBe("ALLOW");
    expect(session.readiness).toBe("unavailable");
    expect(session.prepared).toBeNull();
    expect(blockhash.calls).toEqual([]);
  });

  it("reaches ready only for connected Phantom, genesis, ALLOW, and an exact message", async () => {
    const { evaluation, session } = await preparedAllow();
    expect(evaluation.constraintResult).toBe("ALLOW");
    expect(evaluation.signingReadiness).toBe("not_ready");
    expect(session.readiness).toBe("ready");
    expect(session.prepared?.messageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(session.prepared?.feePayer).toBe(PHANTOM_WALLET.publicKey);
  });

  it("rejects a simulated identity and an unparsable public key", async () => {
    const evaluation = await allowEvaluation(walletWith(PHANTOM_WALLET.publicKey ?? "", "simulation"));
    const simulated = await runPrepare({
      decision: "ALLOW",
      constraintResult: "ALLOW",
      binding: evaluation.approvedBinding,
      bindingSha256: evaluation.approvedBinding?.sha256 ?? null,
      serializedTx: evaluation.serializedTx,
      wallet: evaluation.wallet,
      form: formFrom(evaluation),
      genesisRpc: genesisRpc().rpc,
      blockhashRpc: blockhashRpc().rpc,
    });
    expect(simulated.readiness).toBe("unavailable");
    expect(simulated.prepared).toBeNull();

    const bogus = await runPrepare({
      decision: "ALLOW",
      constraintResult: "ALLOW",
      binding: evaluation.approvedBinding,
      bindingSha256: evaluation.approvedBinding?.sha256 ?? null,
      serializedTx: evaluation.serializedTx,
      wallet: walletWith("FixturePublicKey"),
      form: formFrom(evaluation),
      genesisRpc: genesisRpc().rpc,
      blockhashRpc: blockhashRpc().rpc,
    });
    expect(bogus.readiness).toBe("unavailable");
    expect(bogus.prepared).toBeNull();
  });

  it("drops a ready session when state changes", async () => {
    const { session } = await preparedAllow();
    expect(session.readiness).toBe("ready");
    const dropped = invalidateSigningSession(session, "form changed; signing readiness is unavailable");
    expect(dropped.readiness).toBe("unavailable");
    expect(dropped.prepared).toBeNull();
    expect(dropped.signed).toBeNull();
    expect(session.prepared).not.toBeNull();
  });
});
