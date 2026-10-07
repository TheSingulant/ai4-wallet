import type { RecheckInput } from "../domain/evaluate";
import type { WalletDetection } from "../wallet/types";
import { buildView, type AppView } from "./view";
import type { PreviewEvaluation } from "../domain/evaluate";
import type { WalletSnapshot } from "../domain/types";

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
}

export interface RenderHandlers {
  onConnect: () => void;
  onDisconnect: () => void;
  onFixture: (name: "allow" | "revise" | "refuse") => void;
  onMainnet: () => void;
  onDevnetIntent: () => void;
  onSimulateCluster: (cluster: string) => void;
  onRecheck: (next: RecheckInput) => void;
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
      clusterSelect(handlers),
    ]),
    el("section", {}, [
      el("h2", {}, ["Constraint result"]),
      el("p", {}, ["Fixture preview. This page does not call the constrain engine."]),
      button("ALLOW fixture", () => handlers.onFixture("allow")),
      button("REVISE fixture", () => handlers.onFixture("revise")),
      button("REFUSE fixture", () => handlers.onFixture("refuse")),
      button("Attempt mainnet", handlers.onMainnet),
      button("Use DevNet intent", handlers.onDevnetIntent),
      el("p", { "data-testid": "decision" }, [view.decision]),
      list(view.reasons, "reasons"),
      el("h3", {}, ["Approved binding"]),
      list(view.bindingLines, "binding"),
      el("p", { "data-testid": "signing-handoff" }, [view.signingLine]),
    ]),
    recheckSection(state, handlers),
  );

  return view;
}

function recheckSection(state: RenderState, handlers: RenderHandlers): HTMLElement {
  const form = el("form", { "data-testid": "recheck-form" }, [
    el("h2", {}, ["Recheck after ALLOW"]),
    el("p", {}, [
      "Compare amount, destination, network, and serialized transaction with the last ALLOW snapshot.",
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
  const submit = form.querySelector("button");
  submit?.setAttribute("type", "button");
  return form;
}

function clusterSelect(handlers: RenderHandlers): HTMLElement {
  const select = document.createElement("select");
  select.dataset.testid = "cluster-simulation";
  select.setAttribute("aria-label", "Wallet cluster simulation");
  const options: Array<[string, string]> = [
    ["", "Wallet cluster simulation"],
    ["devnet", "Simulate devnet"],
    ["mainnet-beta", "Simulate mainnet-beta"],
    ["testnet", "Simulate testnet"],
  ];
  for (const [value, label] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.addEventListener("change", () => {
    handlers.onSimulateCluster(select.value);
  });
  const wrap = el("label", {}, ["Cluster simulation. This page does not switch a wallet.", select]);
  return wrap;
}

function field(label: string, name: string, value: string): HTMLElement {
  const input = document.createElement("input");
  input.name = name;
  input.value = value;
  input.autocomplete = "off";
  input.spellcheck = false;
  return el("label", {}, [label, input]);
}

function list(items: string[], testId: string): HTMLElement {
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
