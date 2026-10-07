// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { PRODUCT } from "../src/copy";
import { APP_DEVNET_RPC_URL } from "../src/domain/genesisLive";
import { emptySigningSession, signingControlsLocked } from "../src/domain/signingSession";
import { evaluatePreview } from "../src/domain/evaluate";
import { DISCONNECTED_WALLET } from "../src/domain/types";
import { CONSTRAINT_FIXTURES, DEVNET_TRANSFER } from "../src/fixtures/preview";
import { auditDigestLine, messageHashLine, phase1ReadinessLine } from "../src/ui/phase1View";
import { renderApp, type RenderHandlers } from "../src/ui/render";
import { PHANTOM_WALLET, preparedAllow } from "./phase1/helpers";

const handlers: RenderHandlers = {
  onConnect: () => undefined,
  onDisconnect: () => undefined,
  onFixture: () => undefined,
  onMainnet: () => undefined,
  onDevnetIntent: () => undefined,
  onRecheck: () => undefined,
};

describe("Phase 1 preview UI", () => {
  it("shows an unavailable sign control and does not use trust language before genesis", async () => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: DISCONNECTED_WALLET,
    });
    const root = document.createElement("div");
    let prepares = 0;
    let signs = 0;
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
        phase1: { session: emptySigningSession(), rpcUrl: APP_DEVNET_RPC_URL },
      },
      {
        ...handlers,
        onPrepare: () => {
          prepares += 1;
        },
        onSign: () => {
          signs += 1;
        },
      },
    );
    const text = root.textContent ?? "";
    expect(root.querySelector("[data-testid='posture-devnet-only']")?.textContent).toBe("DEVNET ONLY");
    expect(root.querySelector("[data-testid='posture-local-signature-only']")?.textContent).toBe(
      "LOCAL SIGNATURE ONLY",
    );
    expect(root.querySelector("[data-testid='posture-not-broadcast']")?.textContent).toBe(
      "NOT BROADCAST",
    );
    expect(root.querySelector("[data-testid='custody']")?.textContent).toBe(
      "You sign. AI⁴ cannot move funds.",
    );
    expect(root.querySelector("[data-testid='network-display']")?.textContent).toBe(
      "Network: Solana DevNet.",
    );
    expect(root.querySelector("[data-testid='message-hash']")?.textContent).toBe(
      "Exact message binding: none.",
    );
    expect(root.querySelector("[data-testid='audit-digest']")?.textContent).toBe("Intent binding: none.");
    expect(buttonLabels(root)).not.toContain("Attempt mainnet");
    expect(text).not.toContain("Attempt mainnet");
    expect(root.querySelector("[data-testid='verify-status']")?.textContent).toBe(PRODUCT.verify);
    expect(root.querySelector("[data-testid='decision']")?.textContent).toBe("Constraint result: ALLOW");
    expect(root.querySelector("[data-testid='genesis-status']")?.textContent).toBe(
      "Genesis: not checked.",
    );
    expect(root.querySelector("[data-testid='phase1-readiness']")?.textContent).toBe(
      PRODUCT.phase1Unavailable,
    );
    expect(root.querySelector("[data-testid='broadcast-status']")?.textContent).toBe(
      "Not broadcast.",
    );
    expect(root.querySelector("[data-testid='rpc-url']")?.textContent).toContain(
      "https://api.devnet.solana.com",
    );
    expect(root.querySelector<HTMLButtonElement>("[data-testid='sign-transaction']")?.disabled).toBe(
      true,
    );
    root.querySelector<HTMLButtonElement>("[data-testid='prepare-transfer']")?.click();
    root.querySelector<HTMLButtonElement>("[data-testid='sign-transaction']")?.click();
    expect(prepares).toBe(1);
    expect(signs).toBe(0);
    expect(text).not.toMatch(/\bverified\b/i);
    expect(text).not.toMatch(/\b(secure|safe|trusted)\b/i);
    expect(text).not.toContain("\u2014");
    expect(text).not.toContain("\u2013");
    expect(text).not.toMatch(/verified destination/i);
  });

  it("enables Sign transaction only when readiness is ready and says Genesis verified", async () => {
    const { evaluation, session } = await preparedAllow();
    const root = document.createElement("div");
    let signs = 0;
    renderApp(
      root,
      {
        evaluation,
        wallet: PHANTOM_WALLET,
        detection: { adapterId: "phantom", present: true },
        connectNote: "Phantom returned a public key. No signature was requested.",
        form: {
          amount: "0.001",
          destination: DEVNET_TRANSFER.destination,
          network: "devnet",
          serializedTx: evaluation.serializedTx ?? "",
        },
        phase1: { session, rpcUrl: APP_DEVNET_RPC_URL },
      },
      {
        ...handlers,
        onSign: () => {
          signs += 1;
        },
      },
    );
    const text = root.textContent ?? "";
    expect(root.querySelector("[data-testid='genesis-status']")?.textContent).toBe(
      "Genesis verified.",
    );
    expect(root.querySelector("[data-testid='phase1-readiness']")?.textContent).toBe(
      "Signing status: Ready.",
    );
    expect(root.querySelector("[data-testid='message-hash']")?.textContent).toMatch(
      /^Exact message binding: [0-9a-f]{64}$/,
    );
    expect(root.querySelector("[data-testid='audit-digest']")?.textContent).toMatch(
      /^Intent binding: [0-9a-f]{64}\. /,
    );
    expect(root.querySelector("[data-testid='decision']")?.textContent).toBe("Constraint result: ALLOW");
    expect(root.querySelector("[data-testid='signing-readiness']")).toBeNull();
    expect(root.querySelector("[data-testid='message-hash']")?.textContent).toContain(
      session.prepared?.messageSha256 ?? "",
    );
    expect(root.querySelector("[data-testid='audit-digest']")?.textContent).toContain(
      "does not authorize this signature",
    );
    const sign = root.querySelector<HTMLButtonElement>("[data-testid='sign-transaction']");
    expect(sign?.disabled).toBe(false);
    sign?.click();
    expect(signs).toBe(1);
    expect(text).not.toMatch(/\b(secure|safe|trusted)\b/i);
    expect(text).not.toMatch(/verified destination/i);
    expect(text).not.toContain("\u2014");
    expect(root.querySelector("[data-testid='verify-status']")?.textContent).toContain("Preview");
    expect(text).not.toContain("does not request signatures");
    expect(text).not.toContain("Attempt mainnet");
    expect(text).toContain(PRODUCT.custody);
  });

  it("labels every Phase 1 readiness state as signing status", () => {
    expect(phase1ReadinessLine("unavailable")).toBe("Signing status: Unavailable.");
    expect(phase1ReadinessLine("preparing")).toBe("Signing status: Preparing.");
    expect(phase1ReadinessLine("ready")).toBe("Signing status: Ready.");
    expect(phase1ReadinessLine("signing")).toBe("Signing status: Signing.");
    expect(phase1ReadinessLine("signed")).toBe(
      "Signing status: Signed locally. Not broadcast.",
    );
    expect(phase1ReadinessLine("failed")).toBe("Signing status: Failed.");
    const empty = emptySigningSession();
    expect(messageHashLine(empty)).toBe("Exact message binding: none.");
    expect(auditDigestLine(empty)).toBe("Intent binding: none.");
  });

  it("disables Sign and Prepare while a sign attempt is in flight", async () => {
    const { evaluation, session } = await preparedAllow();
    const signing = {
      ...session,
      readiness: "signing" as const,
      inFlight: true,
    };
    expect(signingControlsLocked(signing)).toBe(true);
    const root = document.createElement("div");
    let prepares = 0;
    let signs = 0;
    renderApp(
      root,
      {
        evaluation,
        wallet: PHANTOM_WALLET,
        detection: { adapterId: "phantom", present: true },
        connectNote: "Phantom returned a public key. No signature was requested.",
        form: {
          amount: "0.001",
          destination: DEVNET_TRANSFER.destination,
          network: "devnet",
          serializedTx: evaluation.serializedTx ?? "",
        },
        phase1: { session: signing, rpcUrl: APP_DEVNET_RPC_URL },
      },
      {
        ...handlers,
        onPrepare: () => {
          prepares += 1;
        },
        onSign: () => {
          signs += 1;
        },
      },
    );
    const prepare = root.querySelector<HTMLButtonElement>("[data-testid='prepare-transfer']");
    const sign = root.querySelector<HTMLButtonElement>("[data-testid='sign-transaction']");
    expect(prepare?.disabled).toBe(true);
    expect(sign?.disabled).toBe(true);
    prepare?.click();
    sign?.click();
    expect(prepares).toBe(0);
    expect(signs).toBe(0);
  });

  it("reports form edits to the caller", async () => {
    const evaluation = await evaluatePreview({
      intent: DEVNET_TRANSFER,
      constraint: CONSTRAINT_FIXTURES.allow,
      wallet: DISCONNECTED_WALLET,
    });
    const root = document.createElement("div");
    let edits = 0;
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
          serializedTx: "",
        },
        phase1: { session: emptySigningSession(), rpcUrl: APP_DEVNET_RPC_URL },
      },
      {
        ...handlers,
        onFormInput: () => {
          edits += 1;
        },
      },
    );
    const input = root.querySelector<HTMLInputElement>("input[name='amount']");
    expect(input).not.toBeNull();
    input!.value = "0.002";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(edits).toBe(1);
  });
});

function buttonLabels(root: HTMLElement): string[] {
  return [...root.querySelectorAll("button")].map((button) => button.textContent ?? "");
}
