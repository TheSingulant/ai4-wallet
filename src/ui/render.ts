import { PRODUCT } from "../copy";
import type { RecheckInput } from "../domain/evaluate";
import type { PreviewEvaluation } from "../domain/evaluate";
import type { SigningSession } from "../domain/signingSession";
import type { WalletSnapshot } from "../domain/types";
import type { WalletDetection } from "../wallet/types";
import {
  auditDigestLine,
  blockhashLine,
  feePayerLine,
  genesisStatusLine,
  messageHashLine,
  phase1ReadinessLine,
  signedResultLine,
} from "./phase1View";
import { buildView, type AppView } from "./view";

export interface Phase1RenderState {
  session: SigningSession;
  rpcUrl: string;
}

export interface RenderState {
  evaluation: PreviewEvaluation;
  wallet: WalletSnapshot;
  detection: WalletDetection;
  connectNote: string;
  form: {
    amount: string;
    destination: string;
    network: string;
    serializedTx: string;
  };
  phase1?: Phase1RenderState;
}

export interface RenderHandlers {
  onConnect: () => void;
  onDisconnect: () => void;
  onFixture: (name: "allow" | "revise" | "refuse") => void;
  onMainnet: () => void;
  onDevnetIntent: () => void;
  onRecheck: (next: RecheckInput) => void;
  onPrepare?: () => void;
  onSign?: () => void;
  onFormInput?: () => void;
}

export function renderApp(
  root: HTMLElement,
  state: RenderState,
  handlers: RenderHandlers,
): AppView {
  const view = buildView(state.evaluation, state.wallet);
  root.replaceChildren();

  root.append(
    el("header", {}, [
      el("h1", {}, [view.title]),
      el("p", {}, [view.subtitle]),
      el("p", {}, [view.custody]),
      el("p", { "data-testid": "verify-status" }, [view.verify]),
      el("p", {}, [view.phase]),
    ]),
    el("section", { "data-testid": "network-banner" }, [
      el("p", { "data-testid": "network-display" }, [view.networkLine]),
      el("p", {}, [view.requiredLine]),
      el("p", { "data-testid": "wallet-display" }, [view.walletLine]),
    ]),
    el("section", {}, [
      el("h2", {}, ["Wallet"]),
      el("p", { "data-testid": "phantom-detection" }, [
        state.detection.present ? "Phantom: detected." : "Phantom: not detected.",
      ]),
      el("p", { "data-testid": "connect-note" }, [state.connectNote]),
      button("Connect Phantom", handlers.onConnect),
      button("Disconnect", handlers.onDisconnect),
    ]),
    constraintSection(view, handlers, state.phase1 === undefined),
    phase1Section(state, handlers),
    recheckSection(state, handlers),
  );

  return view;
}

function constraintSection(
  view: AppView,
  handlers: RenderHandlers,
  showPhase0Readiness: boolean,
): HTMLElement {
  const children: Array<Node | string> = [
    el("h2", {}, ["Constraint result"]),
    el("p", {}, ["Fixture preview. This page does not call the constrain engine."]),
    button("ALLOW fixture", () => handlers.onFixture("allow")),
    button("REVISE fixture", () => handlers.onFixture("revise")),
    button("REFUSE fixture", () => handlers.onFixture("refuse")),
    button("Attempt mainnet", handlers.onMainnet),
    button("Use DevNet intent", handlers.onDevnetIntent),
    el("p", { "data-testid": "decision" }, [view.constraintLine]),
  ];
  if (showPhase0Readiness) {
    children.push(el("p", { "data-testid": "signing-readiness" }, [view.signingLine]));
  }
  const reasons = showPhase0Readiness
    ? view.reasons
    : view.reasons.filter((reason) => reason !== "Phase 0 does not request signatures");
  children.push(list(reasons, "reasons"), el("h3", {}, ["Approved binding"]), list(view.bindingLines, "binding"));
  return el("section", {}, children);
}

function phase1Section(state: RenderState, handlers: RenderHandlers): HTMLElement {
  if (!state.phase1) {
    return el("section", {}, []);
  }
  const session = state.phase1.session;
  const signButton = button(PRODUCT.signButton, () => {
    handlers.onSign?.();
  });
  signButton.dataset.testid = "sign-transaction";
  signButton.disabled = session.readiness !== "ready";
  const prepareButton = button(PRODUCT.prepareButton, () => {
    handlers.onPrepare?.();
  });
  prepareButton.dataset.testid = "prepare-transfer";
  return el("section", { "data-testid": "phase1" }, [
    el("h2", {}, ["DevNet transfer"]),
    el("p", {}, [
      "Native SOL transfer. The app DevNet RPC builds the message. Phantom signs that message. This page does not broadcast it.",
    ]),
    el("p", { "data-testid": "rpc-url" }, [`App DevNet RPC: ${state.phase1.rpcUrl}.`]),
    el("p", { "data-testid": "genesis-status" }, [genesisStatusLine(session)]),
    el("p", { "data-testid": "phase1-readiness" }, [phase1ReadinessLine(session.readiness)]),
    el("p", { "data-testid": "fee-payer" }, [feePayerLine(session)]),
    el("p", { "data-testid": "message-hash" }, [messageHashLine(session)]),
    el("p", { "data-testid": "audit-digest" }, [auditDigestLine(session)]),
    el("p", { "data-testid": "blockhash" }, [blockhashLine(session)]),
    el("p", { "data-testid": "phase1-note" }, [session.note]),
    el("p", { "data-testid": "broadcast-status" }, [PRODUCT.notBroadcast]),
    el("p", { "data-testid": "signed-result" }, [signedResultLine(session)]),
    prepareButton,
    signButton,
  ]);
}

function recheckSection(state: RenderState, handlers: RenderHandlers): HTMLElement {
  const form = el("form", { "data-testid": "recheck-form" }, [
    el("h2", {}, ["Recheck after ALLOW"]),
    el("p", {}, [
      "Compare amount, destination, network, and serialized transaction with the frozen ALLOW snapshot. Recheck uses the current wallet session.",
    ]),
    field("Amount", "amount", state.form.amount),
    field("Destination", "destination", state.form.destination),
    field("Network", "network", state.form.network),
    field("Serialized transaction", "serializedTx", state.form.serializedTx),
    button("Recheck binding", () => {
      const data = new FormData(form);
      handlers.onRecheck({
        amount: stringField(data, "amount"),
        destination: stringField(data, "destination"),
        network: stringField(data, "network"),
        serializedTx: stringField(data, "serializedTx"),
      });
    }),
  ]);
  form.addEventListener("input", () => {
    handlers.onFormInput?.();
  });
  const submit = form.querySelector("button");
  submit?.setAttribute("type", "button");
  return form;
}

function field(label: string, name: string, value: string): HTMLElement {
  const input = document.createElement("input");
  input.name = name;
  input.value = value;
  input.autocomplete = "off";
  input.spellcheck = false;
  return el("label", {}, [label, input]);
}

function list(items: readonly string[], testId: string): HTMLElement {
  const ul = el("ul", { "data-testid": testId }, []);
  for (const item of items) {
    ul.append(el("li", {}, [item]));
  }
  return ul;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

function stringField(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

function el<T extends keyof HTMLElementTagNameMap>(
  tag: T,
  attrs: Record<string, string>,
  children: Array<Node | string>,
): HTMLElementTagNameMap[T] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "data-testid") {
      node.dataset.testid = value;
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}
