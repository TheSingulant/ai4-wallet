import "./style.css";
import {
  DISCONNECTED_WALLET,
  type FrozenAllow,
  type TransferIntentInput,
  type WalletSnapshot,
} from "./domain/types";
import {
  evaluatePreview,
  recheckAfterAllow,
  type PreviewEvaluation,
  type RecheckInput,
} from "./domain/evaluate";
import { CONSTRAINT_FIXTURES, DEVNET_TRANSFER, FIXTURE_DESTINATION } from "./fixtures/preview";
import { renderApp, type RenderState } from "./ui/render";
import { browserWalletScope, phantomAdapter } from "./wallet/phantom";

const root = document.querySelector<HTMLElement>("#app");
if (!root) {
  throw new Error("missing #app");
}

const scope = browserWalletScope();

let wallet: WalletSnapshot = DISCONNECTED_WALLET;
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
let refreshSerial = 0;

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
      wallet = DISCONNECTED_WALLET;
      connectNote = "Wallet disconnected. Signing readiness is unavailable.";
      void refresh(false);
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
    onRecheck: (next) => {
      void recheck(next);
    },
  });
}

async function refresh(resetForm: boolean): Promise<void> {
  const serial = ++refreshSerial;
  const evaluation = await evaluatePreview({
    intent,
    constraint: CONSTRAINT_FIXTURES[fixtureName],
    wallet,
  });
  if (serial !== refreshSerial) {
    return;
  }
  frozen = evaluation.frozen;
  if (resetForm) {
    form = mutableForm(evaluation);
  } else if (form.serializedTx === "" && evaluation.serializedTx) {
    form = { ...form, serializedTx: evaluation.serializedTx };
  }
  await draw(evaluation);
}

function mutableForm(evaluation: PreviewEvaluation): RenderState["form"] {
  const approved = evaluation.frozen?.approvedForm;
  if (approved) {
    return {
      amount: approved.amount,
      destination: approved.destination,
      network: approved.network,
      serializedTx: approved.serializedTx,
    };
  }
  return {
    amount: intent.amount,
    destination: intent.destination,
    network: intent.network,
    serializedTx: "",
  };
}

async function connect(): Promise<void> {
  const detection = phantomAdapter.detect(scope);
  if (!detection.present) {
    wallet = DISCONNECTED_WALLET;
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
  const serial = ++refreshSerial;
  const sessionWallet = wallet;
  form = { ...next };
  if (!frozen) {
    const evaluation = await evaluatePreview({
      intent,
      constraint: CONSTRAINT_FIXTURES[fixtureName],
      wallet: sessionWallet,
    });
    if (serial !== refreshSerial) {
      return;
    }
    await draw({
      ...evaluation,
      reasons: Object.freeze([
        "No ALLOW snapshot is available to recheck.",
        ...evaluation.reasons,
      ]),
    });
    return;
  }
  const snapshot = frozen;
  const result = await recheckAfterAllow(snapshot, next, { wallet: sessionWallet });
  if (serial !== refreshSerial) {
    return;
  }
  if (result.decision !== "ALLOW") {
    frozen = null;
  }
  await draw(result);
}

void refresh(true);
