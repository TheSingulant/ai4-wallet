import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalBindingJson, canonicalSerializedTx, sha256Hex } from "../src/domain/canonical";
import { evaluatePreview, recheckAfterAllow } from "../src/domain/evaluate";
import { DISCONNECTED_WALLET, type WalletSnapshot } from "../src/domain/types";
import {
  ALT_DESTINATION,
  CONSTRAINT_FIXTURES,
  DEVNET_TRANSFER,
  FIXTURE_DESTINATION,
  KNOWN_BINDING_JSON,
  KNOWN_BINDING_SHA256,
} from "../src/fixtures/preview";

const CONNECTED: WalletSnapshot = {
  status: "connected",
  publicKey: "FixturePublicKey",
  source: "phantom",
};

describe("approved binding", () => {
  it("matches the ai4-constrain canonical JSON and sha256 vector", async () => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: DISCONNECTED_WALLET,
    });
    expect(evaluation.approvedBinding).not.toBeNull();
    const json = canonicalBindingJson(evaluation.approvedBinding!);
    expect(json).toBe(KNOWN_BINDING_JSON);
    const oracle = createHash("sha256").update(json).digest("hex");
    expect(oracle).toBe(KNOWN_BINDING_SHA256);
    expect(await sha256Hex(json)).toBe(KNOWN_BINDING_SHA256);
    expect(evaluation.approvedBinding?.sha256).toBe(KNOWN_BINDING_SHA256);
    expect(evaluation.serializedTx).toBe(canonicalSerializedTx(evaluation.approvedBinding!));
    expect(evaluation.signingHandoff).toBeNull();
    expect(evaluation.signingReadiness).toBe("unavailable");
  });

  it("freezes the ALLOW snapshot", async () => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: CONNECTED,
    });
    const frozen = evaluation.frozen;
    expect(frozen).not.toBeNull();
    expect(Object.isFrozen(evaluation)).toBe(true);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen!.binding)).toBe(true);
    expect(Object.isFrozen(frozen!.approvedForm)).toBe(true);
    expect(Object.isFrozen(frozen!.session)).toBe(true);
    expect(Object.isFrozen(evaluation.approvedBinding)).toBe(true);
    expect(Object.isFrozen(evaluation.reasons)).toBe(true);

    expect(() => {
      (frozen!.binding as { destination: string }).destination = ALT_DESTINATION;
    }).toThrow(TypeError);
    expect(() => {
      (frozen as { sha256: string }).sha256 = "0".repeat(64);
    }).toThrow(TypeError);
    expect(() => {
      (frozen as { serializedTx: string }).serializedTx = "tamper";
    }).toThrow(TypeError);
    expect(() => {
      (frozen as { serializedTxSha256: string }).serializedTxSha256 = "00";
    }).toThrow(TypeError);
    expect(() => {
      (frozen!.approvedForm as { amount: string }).amount = "0.002";
    }).toThrow(TypeError);
    expect(() => {
      (evaluation as { signingReadiness: string }).signingReadiness = "ready";
    }).toThrow(TypeError);
    expect(frozen!.binding.destination).toBe(FIXTURE_DESTINATION);
    expect(frozen!.sha256).toBe(KNOWN_BINDING_SHA256);
    expect(evaluation.signingReadiness).toBe("not_ready");
  });

  it("keeps an unchanged snapshot on recheck and still withholds signing", async () => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: CONNECTED,
    });
    const frozen = evaluation.frozen;
    expect(frozen).not.toBeNull();
    const again = await recheckAfterAllow(
      frozen!,
      {
        network: "devnet",
        amount: "0.0010",
        destination: FIXTURE_DESTINATION,
        serializedTx: frozen!.serializedTx,
      },
      { wallet: CONNECTED },
    );
    expect(again.decision).toBe("ALLOW");
    expect(again.constraintResult).toBe("ALLOW");
    expect(again.approvedBinding?.sha256).toBe(KNOWN_BINDING_SHA256);
    expect(again.signingHandoff).toBeNull();
    expect(again.signingReadiness).toBe("not_ready");
    expect(again.wallet).toEqual(CONNECTED);
  });

  it("uses the current disconnected session on recheck", async () => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: DISCONNECTED_WALLET,
    });
    const again = await recheckAfterAllow(
      evaluation.frozen!,
      {
        network: "devnet",
        amount: "0.001",
        destination: FIXTURE_DESTINATION,
        serializedTx: evaluation.frozen!.serializedTx,
      },
      { wallet: DISCONNECTED_WALLET },
    );
    expect(again.decision).toBe("ALLOW");
    expect(again.constraintResult).toBe("ALLOW");
    expect(again.signingReadiness).toBe("unavailable");
    expect(again.wallet.status).toBe("disconnected");
  });

  it("drops readiness when the wallet session changes and keeps constraint ALLOW", async () => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: DISCONNECTED_WALLET,
    });
    const connected = await recheckAfterAllow(
      evaluation.frozen!,
      {
        network: "devnet",
        amount: "0.001",
        destination: FIXTURE_DESTINATION,
        serializedTx: evaluation.frozen!.serializedTx,
      },
      { wallet: CONNECTED },
    );
    expect(connected.decision).toBe("ALLOW");
    expect(connected.constraintResult).toBe("ALLOW");
    expect(connected.approvedBinding).not.toBeNull();
    expect(connected.signingReadiness).toBe("unavailable");
    expect(connected.reasons).toContain(
      "wallet session changed after ALLOW; signing readiness is unavailable",
    );

    const approved = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: CONNECTED,
    });
    const disconnected = await recheckAfterAllow(
      approved.frozen!,
      {
        network: "devnet",
        amount: "0.001",
        destination: FIXTURE_DESTINATION,
        serializedTx: approved.frozen!.serializedTx,
      },
      { wallet: DISCONNECTED_WALLET },
    );
    expect(disconnected.decision).toBe("ALLOW");
    expect(disconnected.signingReadiness).toBe("unavailable");

    const otherKey = await recheckAfterAllow(
      approved.frozen!,
      {
        network: "devnet",
        amount: "0.001",
        destination: FIXTURE_DESTINATION,
        serializedTx: approved.frozen!.serializedTx,
      },
      {
        wallet: {
          status: "connected",
          publicKey: "OtherKey",
          source: "phantom",
        },
      },
    );
    expect(otherKey.decision).toBe("ALLOW");
    expect(otherKey.signingReadiness).toBe("unavailable");
    expect(otherKey.signingReadiness).not.toBe("ready");
  });

  it.each([
    ["amount", { amount: "0.002" }, "amount changed after ALLOW"],
    ["destination", { destination: ALT_DESTINATION }, "destination changed after ALLOW"],
    ["network", { network: "mainnet-beta" }, "network changed after ALLOW"],
  ] as const)("fail closed when %s changes after ALLOW", async (_label, patch, reason) => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: CONNECTED,
    });
    const frozen = evaluation.frozen!;
    const result = await recheckAfterAllow(
      frozen,
      {
        network: "devnet",
        amount: "0.001",
        destination: FIXTURE_DESTINATION,
        serializedTx: frozen.serializedTx,
        ...patch,
      },
      { wallet: CONNECTED },
    );
    expect(result.decision).toBe("DENY");
    expect(result.constraintResult).toBeNull();
    expect(result.signingReadiness).toBe("unavailable");
    expect(result.reasons).toContain(reason);
    expect(result.approvedBinding).toBeNull();
    expect(result.serializedTx).toBeNull();
    expect(result.signingHandoff).toBeNull();
    expect(result.frozen).toBeNull();
  });

  it("fail closed when the serialized transaction changes after ALLOW", async () => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: CONNECTED,
    });
    const frozen = evaluation.frozen!;
    const result = await recheckAfterAllow(
      frozen,
      {
        network: "devnet",
        amount: "0.001",
        destination: FIXTURE_DESTINATION,
        serializedTx: `${frozen.serializedTx}|extra`,
      },
      { wallet: CONNECTED },
    );
    expect(result.decision).toBe("DENY");
    expect(result.signingReadiness).toBe("unavailable");
    expect(result.reasons).toContain("serialized transaction changed after ALLOW");
    expect(result.approvedBinding).toBeNull();
    expect(result.signingHandoff).toBeNull();
  });
});
