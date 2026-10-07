import "./style.css";
import { APP_DEVNET_RPC_URL, RPC_TIMEOUT_MS } from "./domain/genesisLive";
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
import { createPhase1Session } from "./app/phase1Session";
import type { TransferForm } from "./domain/signingSession";
import { CONSTRAINT_FIXTURES, DEVNET_TRANSFER, FIXTURE_DESTINATION } from "./fixtures/preview";
import { renderApp, type RenderState } from "./ui/render";
import {
  blockhashFreshnessFromConnection,
  blockhashSourceFromConnection,
  createAppDevnetConnection,
  genesisRpcFromConnection,
} from "./solana/devnetConnection";
import {
  browserWalletScope,
  phantomAdapter,
  readPhantomPublicKey,
  signTransaction,
  subscribePhantomSession,
} from "./wallet/phantom";

const root = document.querySelector<HTMLElement>("#app");
if (!root) {
  throw new Error("missing #app");
}

const scope = browserWalletScope();

let wallet: WalletSnapshot = DISCONNECTED_WALLET;
let intent: TransferIntentInput = { ...DEVNET_TRANSFER };
let fixtureName: "allow" | "revise" | "refuse" = "allow";
let frozen: FrozenAllow | null = null;
let connectNote = "Connect reads a public key only. A signature requires a separate click.";
let form: TransferForm = {
  amount: DEVNET_TRANSFER.amount,
  destination: FIXTURE_DESTINATION,
  network: DEVNET_TRANSFER.network,
  serializedTx: "",
};
let currentEvaluation: PreviewEvaluation | null = null;
let refreshSerial = 0;
let unsubscribePhantom: () => void = () => undefined;

const runtime = createPhase1Session({
  getWallet: () => wallet,
  getForm: () => form,
  getEvaluation: () => currentEvaluation,
  draw: async () => {
    if (currentEvaluation) {
      await draw(currentEvaluation);
    }
  },
  readProviderPublicKey: () => readPhantomPublicKey(scope),
  sign: (transaction) => signTransaction(scope, transaction),
  genesisRpc: () => genesisRpcFromConnection(createAppDevnetConnection(RPC_TIMEOUT_MS)),
  blockhashSource: () => blockhashSourceFromConnection(createAppDevnetConnection(RPC_TIMEOUT_MS)),
  blockhashProbe: () => blockhashFreshnessFromConnection(createAppDevnetConnection(RPC_TIMEOUT_MS)),
  timeoutMs: RPC_TIMEOUT_MS,
});

function bindPhantomEvents(): void {
  unsubscribePhantom();
  unsubscribePhantom = subscribePhantomSession(scope, {
    onAccountChanged: (publicKey) => {
      applyWalletIdentity(publicKey, "Phantom account changed. Signing readiness is unavailable.");
    },
    onDisconnect: () => {
      applyWalletIdentity(null, "Wallet disconnected. Signing readiness is unavailable.");
    },
  });
}

function applyWalletIdentity(publicKey: string | null, note: string): void {
  const next: WalletSnapshot =
    publicKey === null
      ? DISCONNECTED_WALLET
      : Object.freeze({
          status: "connected",
          publicKey,
          source: "phantom",
        });
  if (next.status === wallet.status && next.publicKey === wallet.publicKey && next.source === wallet.source) {
    return;
  }
  wallet = next;
  connectNote = note;
  runtime.drop("wallet session changed; signing readiness is unavailable");
  void refresh(false);
}

async function draw(evaluation: PreviewEvaluation): Promise<void> {
  currentEvaluation = evaluation;
  const state: RenderState = {
    evaluation,
    wallet,
    detection: phantomAdapter.detect(scope),
    connectNote,
    form,
    phase1: {
      session: runtime.session,
      rpcUrl: APP_DEVNET_RPC_URL,
    },
  };
  renderApp(root as HTMLElement, state, {
    onConnect: () => {
      void connect();
    },
    onDisconnect: () => {
      wallet = DISCONNECTED_WALLET;
      connectNote = "Wallet disconnected. Signing readiness is unavailable.";
      runtime.drop("wallet session changed; signing readiness is unavailable");
      void refresh(false);
    },
    onFixture: (name) => {
      fixtureName = name;
      intent = { ...DEVNET_TRANSFER };
      runtime.drop("constraint fixture changed; signing readiness is unavailable");
      void refresh(true);
    },
    onMainnet: () => {
      intent = { ...DEVNET_TRANSFER, network: "mainnet-beta" };
      runtime.drop("network intent changed; signing readiness is unavailable");
      void refresh(true);
    },
    onDevnetIntent: () => {
      intent = { ...DEVNET_TRANSFER };
      runtime.drop("network intent changed; signing readiness is unavailable");
      void refresh(true);
    },
    onRecheck: (next) => {
      void recheck(next);
    },
    onPrepare: () => {
      void runtime.prepare();
    },
    onSign: () => {
      void runtime.sign();
    },
    onFormInput: () => {
      const next = readForm();
      if (!next || sameForm(next, form)) {
        return;
      }
      form = next;
      runtime.drop("form changed; signing readiness is unavailable");
      if (currentEvaluation) {
        void draw(currentEvaluation);
      }
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

function mutableForm(evaluation: PreviewEvaluation): TransferForm {
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
    runtime.drop("wallet session changed; signing readiness is unavailable");
    await refresh(false);
    return;
  }
  const next = await phantomAdapter.connect(scope);
  const changed =
    next.status !== wallet.status || next.publicKey !== wallet.publicKey || next.source !== wallet.source;
  wallet = next;
  connectNote =
    wallet.status === "connected"
      ? "Phantom returned a public key. No signature was requested."
      : "Phantom connect did not return a public key.";
  if (changed) {
    runtime.drop("wallet session changed; signing readiness is unavailable");
  }
  bindPhantomEvents();
  await refresh(false);
}

async function recheck(next: RecheckInput): Promise<void> {
  const serial = ++refreshSerial;
  const sessionWallet = wallet;
  form = { ...next };
  runtime.drop("recheck ran; signing readiness is unavailable");
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

function readForm(): TransferForm | null {
  const formEl = root?.querySelector<HTMLFormElement>("[data-testid='recheck-form']");
  if (!formEl) {
    return null;
  }
  const data = new FormData(formEl);
  return {
    amount: stringField(data, "amount"),
    destination: stringField(data, "destination"),
    network: stringField(data, "network"),
    serializedTx: stringField(data, "serializedTx"),
  };
}

function sameForm(left: TransferForm, right: TransferForm): boolean {
  return (
    left.amount === right.amount &&
    left.destination === right.destination &&
    left.network === right.network &&
    left.serializedTx === right.serializedTx
  );
}

function stringField(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

bindPhantomEvents();
void refresh(true);
