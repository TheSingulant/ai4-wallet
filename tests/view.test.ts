// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { PRODUCT } from "../src/copy";
import { evaluatePreview } from "../src/domain/evaluate";
import { DISCONNECTED_WALLET, type WalletSnapshot } from "../src/domain/types";
import { CONSTRAINT_FIXTURES, DEVNET_TRANSFER } from "../src/fixtures/preview";
import { renderApp, type RenderHandlers } from "../src/ui/render";
import { verifyLine } from "../src/ui/view";

const handlers: RenderHandlers = {
  onConnect: () => undefined,
  onDisconnect: () => undefined,
  onFixture: () => undefined,
  onMainnet: () => undefined,
  onDevnetIntent: () => undefined,
  onRecheck: () => undefined,
};

describe("preview UI", () => {
  it("shows constraint ALLOW and unavailable signing readiness when disconnected", async () => {
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
      handlers,
    );

    const text = root.textContent ?? "";
    expect(text).toContain(PRODUCT.title);
    expect(text).toContain(PRODUCT.subtitle);
    expect(text).toContain(PRODUCT.custody);
    expect(root.querySelector("[data-testid='verify-status']")?.textContent).toBe(
      verifyLine(evaluation.verify),
    );
    expect(root.querySelector("[data-testid='verify-status']")?.textContent).toBe(PRODUCT.verify);
    expect(root.querySelector("[data-testid='verify-status']")?.textContent).toContain(
      evaluation.verify.label,
    );
    expect(root.querySelector("[data-testid='verify-status']")?.textContent).toContain(
      evaluation.verify.detail,
    );
    expect(root.querySelector("[data-testid='network-display']")?.textContent).toBe(
      "Network: Solana DevNet.",
    );
    expect(root.querySelector("[data-testid='posture-strip']")?.textContent).toContain("DEVNET ONLY");
    expect(root.querySelector("[data-testid='posture-strip']")?.textContent).toContain(
      "LOCAL SIGNATURE ONLY",
    );
    expect(root.querySelector("[data-testid='posture-strip']")?.textContent).toContain("NOT BROADCAST");
    expect(text).toContain("You sign. AI⁴ cannot move funds.");
    expect(text).not.toContain("Attempt mainnet");
    expect(root.querySelector("[data-testid='decision']")?.textContent).toBe(
      "Constraint result: ALLOW",
    );
    expect(root.querySelector("[data-testid='signing-readiness']")?.textContent).toBe(
      "Signing readiness: Unavailable. Phase 0 does not request signatures.",
    );
    expect(root.querySelector("[data-testid='wallet-display']")?.textContent).toContain(
      "disconnected",
    );
    expect(text).not.toMatch(/\bVERIFIED\b/);
    expect(text).not.toMatch(/\b(secure|safe|trusted)\b/i);
    expect(text).not.toContain("\u2014");
    expect(text).not.toContain("\u2013");
    expect(text).not.toContain("Cluster");
    expect(root.querySelector("[data-testid='binding']")?.textContent).toContain("sha256:");
  });

  it("shows not_ready for a connected identity without a signature request", async () => {
    const wallet: WalletSnapshot = {
      status: "connected",
      publicKey: "FixturePublicKey",
      source: "phantom",
    };
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet,
    });
    const root = document.createElement("div");
    renderApp(
      root,
      {
        evaluation,
        wallet,
        detection: { adapterId: "phantom", present: true },
        connectNote: "Phantom connect stub returned a public key. No signature was requested.",
        form: {
          amount: "0.001",
          destination: DEVNET_TRANSFER.destination,
          network: "devnet",
          serializedTx: evaluation.serializedTx ?? "",
        },
      },
      handlers,
    );
    expect(root.querySelector("[data-testid='decision']")?.textContent).toBe(
      "Constraint result: ALLOW",
    );
    expect(root.querySelector("[data-testid='signing-readiness']")?.textContent).toBe(
      "Signing readiness: Not ready. Phase 0 does not request signatures.",
    );
    expect(root.querySelector("[data-testid='wallet-display']")?.textContent).toBe(
      "Wallet: connected FixturePublicKey.",
    );
    expect(root.querySelector("[data-testid='network-display']")?.textContent).toBe(
      "Network: Solana DevNet.",
    );
    expect([...root.querySelectorAll("button")].map((button) => button.textContent)).not.toContain(
      "Attempt mainnet",
    );
  });

  it("shows transaction-control DENY for a mainnet intent", async () => {
    const evaluation = await evaluatePreview({
      intent: { ...DEVNET_TRANSFER, network: "mainnet-beta" },
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
          network: "mainnet-beta",
          serializedTx: "",
        },
      },
      handlers,
    );
    expect(root.querySelector("[data-testid='decision']")?.textContent).toBe(
      "Transaction control: DENY",
    );
    expect(root.querySelector("[data-testid='signing-readiness']")?.textContent).toBe(
      PRODUCT.signingUnavailable,
    );
    expect(root.querySelector("[data-testid='network-display']")?.textContent).toContain(
      "mainnet-beta",
    );
    expect(root.querySelector("[data-testid='network-display']")?.textContent).toBe(
      "Network: mainnet-beta. Phase 0 requires DevNet.",
    );
    expect([...root.querySelectorAll("button")].map((button) => button.textContent)).not.toContain(
      "Attempt mainnet",
    );
  });
});
