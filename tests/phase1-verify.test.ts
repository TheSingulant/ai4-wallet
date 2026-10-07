import { describe, expect, it } from "vitest";
import { PHASE0_BOUNDARIES, PHASE1_BOUNDARIES } from "../src/domain/boundaries";
import { readVerifyStatus } from "../src/domain/verify";
import { PRODUCT } from "../src/copy";
import { emptySigningSession } from "../src/domain/signingSession";
import { genesisStatusLine } from "../src/ui/phase1View";
import { DEVNET_GENESIS_HASH } from "../src/domain/networkAuthority";

describe("Verify boundary", () => {
  it("stays on Preview and does not call production Verify", () => {
    const status = readVerifyStatus();
    expect(status).toEqual({
      interfaceId: "ai4.verify.preview.v0",
      mode: "preview",
      label: "Preview",
      productionVerifierActive: false,
      productionCalled: false,
      unsWrites: false,
      detail: "Production verifier not active.",
    });
    expect(PHASE0_BOUNDARIES.verifyProductionCalled).toBe(false);
    expect(PHASE0_BOUNDARIES.unsWrites).toBe(false);
    expect(PHASE1_BOUNDARIES.verifyProductionCalled).toBe(false);
    expect(PHASE1_BOUNDARIES.unsWrites).toBe(false);
    expect(PRODUCT.verify).toBe("Identity verification: Preview / Production verifier not active.");
  });

  it("says Genesis verified only after the check passes", () => {
    expect(genesisStatusLine(emptySigningSession())).toBe("Genesis: not checked.");
    expect(genesisStatusLine(emptySigningSession())).not.toMatch(/\bverified\b/i);
    expect(
      genesisStatusLine({
        readiness: "preparing",
        genesis: null,
      }),
    ).toBe("Genesis: checking.");
    expect(
      genesisStatusLine({
        readiness: "unavailable",
        genesis: {
          ok: false,
          expectedGenesisHash: DEVNET_GENESIS_HASH,
          observedGenesisHash: null,
          checked: false,
          liveRpc: true,
          reason: "genesis hash request failed",
        },
      }),
    ).toBe("Genesis check failed.");
    expect(
      genesisStatusLine({
        readiness: "ready",
        genesis: {
          ok: true,
          expectedGenesisHash: DEVNET_GENESIS_HASH,
          observedGenesisHash: DEVNET_GENESIS_HASH,
          checked: true,
          liveRpc: true,
          reason: null,
        },
      }),
    ).toBe("Genesis verified.");
  });
});
