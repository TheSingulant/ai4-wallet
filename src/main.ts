import "./style.css";
import { DISCONNECTED_WALLET, type TransferIntentInput, type WalletSnapshot } from "./domain/types";
import { evaluatePreview, recheckAfterAllow, type FrozenAllow, type PreviewEvaluation, type RecheckInput } from "./domain/evaluate";
import { CONSTRAINT_FIXTURES, DEVNET_TRANSFER, FIXTURE_DESTINATION } from "./fixtures/preview";
import { renderApp, type RenderState } from "./ui/render";
import { browserWalletScope, phantomAdapter } from "./wallet/phantom";

const root = document.querySelector<HTMLElement>("#app");
if (!root) {
  throw new Error("missing #app");
}

const scope = browserWalletScope();

let wallet: WalletSnapshot = { ...DISCONNECTED_WALLET };
let intent: TransferIntentInput = { ...DEVNET_TRANSFER };
let fixtureName: "allow" | "revise" | "refuse" = "allow";
let frozen: FrozenAllow | null = null;
let connectNote = "Connect reads a public key only. Phase 0 does not request a signature.";
let form = {
  amount: DEVNET_TRANSFER.amount,
  destination: FIXTURE_DESTINATION,
  network: DEVNET_TRANSFER.network,
  serializedTx: "",
};

async function draw(evaluation: PreviewEvaluation): Promise<void> {
  const state: RenderState = {
    evaluation,
    wallet,
    detection: phantomAdapter.detect(scope),
    connectNote,
    form,
  };
  renderApp(root as HTMLElement, state, {
    onConnect: () => {
      void connect();
    },
    onDisconnect: () => {
      wallet = { ...DISCONNECTED_WALLET };
      connectNote = "Wallet disconnected. Signing handoff is not available.";
      void refresh();
    },
    onFixture: (name) => {
      fixtureName = name;
      intent = { ...DEVNET_TRANSFER };
      void refresh(true);
    },
    onMainnet: () => {
      intent = { ...DEVNET_TRANSFER, network: "mainnet-beta" };
      void refresh(true);
    },
    onDevnetIntent: () => {
      intent = { ...DEVNET_TRANSFER };
      void refresh(true);
    },
    onSimulateCluster: (cluster) => {
      if (cluster === "") {
        wallet = { ...DISCONNECTED_WALLET };
        connectNote = "Cluster simulation cleared. Wallet is disconnected.";
      } else {
        wallet = {
          status: "connected",
          publicKey: null,
          network: cluster,
          source: "simulation",
        };
        connectNote = `Simulated wallet cluster ${cluster}. Not a live wallet. No signature was requested.`;
      }
      void refresh(false);
    },
    onRecheck: (next) => {
      void recheck(next);
    },
  });
}

async function refresh(resetForm: boolean): Promise<void> {
  const evaluation = await evaluatePreview({
    intent,
    constraint: CONSTRAINT_FIXTURES[fixtureName],
    wallet,
  });
  frozen = evaluation.frozen;
  if (resetForm) {
    form = {
      amount: intent.amount,
      destination: intent.destination,
      network: intent.network,
      serializedTx: evaluation.serializedTx ?? "",
    };
  } else if (form.serializedTx === "" && evaluation.serializedTx) {
    form = { ...form, serializedTx: evaluation.serializedTx };
  }
  await draw(evaluation);
}

async function connect(): Promise<void> {
  const detection = phantomAdapter.detect(scope);
  if (!detection.present) {
    wallet = { ...DISCONNECTED_WALLET };
    connectNote = "Phantom was not detected.";
    await refresh(false);
    return;
  }
  wallet = await phantomAdapter.connect(scope);
  connectNote =
    wallet.status === "connected"
      ? "Phantom connect stub returned a public key. No signature was requested."
      : "Phantom connect did not return a public key.";
  await refresh(false);
}

async function recheck(next: RecheckInput): Promise<void> {
  form = { ...next };
  if (!frozen) {
    const evaluation = await evaluatePreview({
      intent,
      constraint: CONSTRAINT_FIXTURES[fixtureName],
      wallet,
    });
    evaluation.reasons = [
      "No ALLOW snapshot is available to recheck.",
      ...evaluation.reasons,
    ];
    await draw(evaluation);
    return;
  }
  const result = await recheckAfterAllow(frozen, next);
  if (result.decision !== "ALLOW") {
    frozen = null;
  }
  await draw(result);
}

void refresh(true);
