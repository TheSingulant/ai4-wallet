// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { PRODUCT } from "../src/copy";
import { evaluatePreview } from "../src/domain/evaluate";
import { DISCONNECTED_WALLET } from "../src/domain/types";
import { CONSTRAINT_FIXTURES, DEVNET_TRANSFER } from "../src/fixtures/preview";
import { renderApp } from "../src/ui/render";

describe("preview UI", () => {
  it("shows the network, the constraint result, and no signing handoff", async () => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: DISCONNECTED_WALLET,
    });
    const root = document.createElement("div");
    renderApp(
      root,
      {
        evaluation,
        wallet: DISCONNECTED_WALLET,
        detection: { adapterId: "phantom", present: false },
        connectNote: "Phantom was not detected.",
        form: {
          amount: "0.001",
          destination: DEVNET_TRANSFER.destination,
          network: "devnet",
          serializedTx: evaluation.serializedTx ?? "",
        },
      },
      {
        onConnect: () => undefined,
        onDisconnect: () => undefined,
        onFixture: () => undefined,
        onMainnet: () => undefined,
        onDevnetIntent: () => undefined,
        onSimulateCluster: () => undefined,
        onRecheck: () => undefined,
      },
    );

    const text = root.textContent ?? "";
    expect(text).toContain(PRODUCT.title);
    expect(text).toContain(PRODUCT.subtitle);
    expect(text).toContain(PRODUCT.custody);
    expect(text).toContain(PRODUCT.verify);
    expect(root.querySelector("[data-testid='network-display']")?.textContent).toContain("DevNet");
    expect(root.querySelector("[data-testid='decision']")?.textContent).toBe("ALLOW");
    expect(root.querySelector("[data-testid='wallet-display']")?.textContent).toContain("disconnected");
    expect(root.querySelector("[data-testid='signing-handoff']")?.textContent).toContain("none");
    expect(text).not.toMatch(/\bVERIFIED\b/);
    expect(root.querySelector("[data-testid='binding']")?.textContent).toContain("sha256:");
  });
});
