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
import {
  beginPreparing,
  emptySigningSession,
  invalidateSigningSession,
  runPrepare,
  signIfGated,
  type SigningSession,
  type TransferForm,
} from "./domain/signingSession";
import { CONSTRAINT_FIXTURES, DEVNET_TRANSFER, FIXTURE_DESTINATION } from "./fixtures/preview";
import { renderApp, type RenderState } from "./ui/render";
import {
  blockhashFreshnessFromConnection,
  blockhashSourceFromConnection,
  createAppDevnetConnection,
  genesisRpcFromConnection,
} from "./solana/devnetConnection";
import { browserWalletScope, phantomAdapter, signTransaction } from "./wallet/phantom";

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
let session: SigningSession = emptySigningSession();
let currentEvaluation: PreviewEvaluation | null = null;
let refreshSerial = 0;
let sessionSerial = 0;

function appConnection() {
  return createAppDevnetConnection();
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
      session,
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
      dropSession("wallet session changed; signing readiness is unavailable");
      void refresh(false);
    },
    onFixture: (name) => {
      fixtureName = name;
      intent = { ...DEVNET_TRANSFER };
      dropSession("constraint fixture changed; signing readiness is unavailable");
      void refresh(true);
    },
    onMainnet: () => {
      intent = { ...DEVNET_TRANSFER, network: "mainnet-beta" };
      dropSession("network intent changed; signing readiness is unavailable");
      void refresh(true);
    },
    onDevnetIntent: () => {
      intent = { ...DEVNET_TRANSFER };
      dropSession("network intent changed; signing readiness is unavailable");
      void refresh(true);
    },
    onRecheck: (next) => {
      void recheck(next);
    },
    onPrepare: () => {
      void prepareTransfer();
    },
    onSign: () => {
      void signTransfer();
    },
    onFormInput: () => {
      const next = readForm();
      if (!next || sameForm(next, form)) {
        return;
      }
      form = next;
      dropSession("form changed; signing readiness is unavailable");
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
    dropSession("wallet session changed; signing readiness is unavailable");
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
    dropSession("wallet session changed; signing readiness is unavailable");
  }
  await refresh(false);
}

async function recheck(next: RecheckInput): Promise<void> {
  const serial = ++refreshSerial;
  const sessionWallet = wallet;
  form = { ...next };
  dropSession("recheck ran; signing readiness is unavailable");
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

async function prepareTransfer(): Promise<void> {
  const evaluation = currentEvaluation;
  if (!evaluation) {
    return;
  }
  const serial = ++sessionSerial;
  session = beginPreparing(session);
  await draw(evaluation);
  const connection = appConnection();
  const next = await runPrepare({
    decision: evaluation.decision,
    constraintResult: evaluation.constraintResult,
    binding: evaluation.approvedBinding,
    bindingSha256: evaluation.approvedBinding?.sha256 ?? null,
    serializedTx: evaluation.serializedTx,
    wallet,
    form,
    genesisRpc: genesisRpcFromConnection(connection),
    blockhashRpc: blockhashSourceFromConnection(connection),
    timeoutMs: RPC_TIMEOUT_MS,
  });
  if (serial !== sessionSerial) {
    return;
  }
  session = next;
  await draw(evaluation);
}

async function signTransfer(): Promise<void> {
  if (session.readiness !== "ready" || !currentEvaluation) {
    return;
  }
  const evaluation = currentEvaluation;
  const serial = ++sessionSerial;
  const connection = appConnection();
  const outcome = await signIfGated({
    session,
    wallet,
    form,
    genesisRpc: genesisRpcFromConnection(connection),
    blockhashProbe: blockhashFreshnessFromConnection(connection),
    timeoutMs: RPC_TIMEOUT_MS,
    sign: (transaction) => signTransaction(scope, transaction),
    onReadiness: (readiness) => {
      if (serial !== sessionSerial) {
        return;
      }
      session = Object.freeze({
        ...session,
        readiness,
        note: "Waiting for Phantom signTransaction.",
      });
      void draw(evaluation);
    },
  });
  if (serial !== sessionSerial) {
    return;
  }
  session = outcome.session;
  await draw(evaluation);
}

function dropSession(note: string): void {
  sessionSerial += 1;
  session = invalidateSigningSession(session, note);
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

void refresh(true);
