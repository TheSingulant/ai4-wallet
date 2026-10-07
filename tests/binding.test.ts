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

const CONNECTED_DEVNET: WalletSnapshot = {
  status: "connected",
  publicKey: "FixturePublicKey",
  network: "devnet",
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
  });

  it("keeps an unchanged snapshot on recheck and still withholds signing", async () => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: CONNECTED_DEVNET,
    });
    const frozen = evaluation.frozen;
    expect(frozen).not.toBeNull();
    const again = await recheckAfterAllow(frozen!, {
      network: "devnet",
      amount: "0.0010",
      destination: FIXTURE_DESTINATION,
      serializedTx: frozen!.serializedTx,
    });
    expect(again.decision).toBe("ALLOW");
    expect(again.approvedBinding?.sha256).toBe(KNOWN_BINDING_SHA256);
    expect(again.signingHandoff).toBeNull();
  });

  it.each([
    ["amount", { amount: "0.002" }, "amount changed after ALLOW"],
    ["destination", { destination: ALT_DESTINATION }, "destination changed after ALLOW"],
    ["network", { network: "mainnet-beta" }, "network changed after ALLOW"],
  ] as const)("fail closed when %s changes after ALLOW", async (_label, patch, reason) => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: CONNECTED_DEVNET,
    });
    const frozen = evaluation.frozen!;
    const result = await recheckAfterAllow(frozen, {
      network: "devnet",
      amount: "0.001",
      destination: FIXTURE_DESTINATION,
      serializedTx: frozen.serializedTx,
      ...patch,
    });
    expect(result.decision).toBe("DENY");
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
      wallet: CONNECTED_DEVNET,
    });
    const frozen = evaluation.frozen!;
    const result = await recheckAfterAllow(frozen, {
      network: "devnet",
      amount: "0.001",
      destination: FIXTURE_DESTINATION,
      serializedTx: `${frozen.serializedTx}|extra`,
    });
    expect(result.decision).toBe("DENY");
    expect(result.reasons).toContain("serialized transaction changed after ALLOW");
    expect(result.approvedBinding).toBeNull();
    expect(result.signingHandoff).toBeNull();
  });
});
