import { describe, expect, it } from "vitest";
import { PHASE0_BOUNDARIES } from "../src/domain/boundaries";
import { evaluatePreview } from "../src/domain/evaluate";
import { readVerifyStatus } from "../src/domain/verify";
import { DISCONNECTED_WALLET } from "../src/domain/types";
import { CONSTRAINT_FIXTURES, DEVNET_TRANSFER } from "../src/fixtures/preview";
import { buildView, collectViewText } from "../src/ui/view";

describe("Verify stub", () => {
  it("stays on Preview and does not call production Verify", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error("network is not used");
    }) as typeof fetch;
    try {
      const status = readVerifyStatus();
      const evaluation = await evaluatePreview({
        intent: DEVNET_TRANSFER,
        constraint: CONSTRAINT_FIXTURES.allow,
        wallet: DISCONNECTED_WALLET,
      });
      expect(status).toEqual({
        interfaceId: "ai4.verify.preview.v0",
        mode: "preview",
        label: "Preview",
        productionVerifierActive: false,
        productionCalled: false,
        unsWrites: false,
        detail: "Production verifier not active.",
      });
      expect(evaluation.verify).toEqual(status);
      expect(calls).toEqual([]);
      expect(PHASE0_BOUNDARIES.verifyProductionCalled).toBe(false);
      expect(PHASE0_BOUNDARIES.unsWrites).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not present a VERIFIED status or trust language", async () => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.refuse,
      wallet: DISCONNECTED_WALLET,
    });
    const text = collectViewText(buildView(evaluation, DISCONNECTED_WALLET));
    expect(text).toContain("Identity verification: Preview / Production verifier not active.");
    expect(text).toContain("REFUSE");
    expect(text).not.toMatch(/\bverified\b/i);
    expect(text).not.toMatch(/\b(secure|safe|trusted)\b/i);
  });
});
