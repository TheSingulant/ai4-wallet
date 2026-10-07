import { PRODUCT } from "../copy";
import { isDevnet } from "../domain/devnetGuard";
import type { PreviewEvaluation } from "../domain/evaluate";
import type { WalletSnapshot } from "../domain/types";

export interface AppView {
  title: string;
  subtitle: string;
  custody: string;
  verify: string;
  networkLine: string;
  requiredLine: string;
  walletLine: string;
  decision: string;
  reasons: string[];
  bindingLines: string[];
  signingLine: string;
  phase: string;
}

export function buildView(evaluation: PreviewEvaluation, wallet: WalletSnapshot): AppView {
  const bindingLines =
    evaluation.approvedBinding === null
      ? ["No approved binding."]
      : [
          `network: ${evaluation.approvedBinding.network}`,
          `asset: ${evaluation.approvedBinding.asset}`,
          `action: ${evaluation.approvedBinding.action}`,
          `amount_sol: ${evaluation.approvedBinding.amount_sol}`,
          `lamports: ${String(evaluation.approvedBinding.lamports)}`,
          `destination: ${evaluation.approvedBinding.destination}`,
          `sha256: ${evaluation.approvedBinding.sha256}`,
          `serialized_tx_sha256: ${evaluation.serializedTxSha256 ?? ""}`,
        ];

  const guardNote = isDevnet(evaluation.networkDisplay)
    ? ""
    : " Phase 0 requires DevNet.";

  return {
    title: PRODUCT.title,
    subtitle: PRODUCT.subtitle,
    custody: PRODUCT.custody,
    verify: PRODUCT.verify,
    networkLine: `Network: ${evaluation.networkDisplay}.${guardNote}`.trim(),
    requiredLine: "Required network: DevNet.",
    walletLine: walletLine(wallet),
    decision: evaluation.decision,
    reasons: evaluation.reasons,
    bindingLines,
    signingLine: PRODUCT.signingNone,
    phase: PRODUCT.phase,
  };
}

export function collectViewText(view: AppView): string {
  return [
    view.title,
    view.subtitle,
    view.custody,
    view.verify,
    view.networkLine,
    view.requiredLine,
    view.walletLine,
    view.decision,
    ...view.reasons,
    ...view.bindingLines,
    view.signingLine,
    view.phase,
  ].join("\n");
}

function walletLine(wallet: WalletSnapshot): string {
  if (wallet.status === "disconnected") {
    return "Wallet: disconnected.";
  }
  const cluster = wallet.network ?? "(not reported)";
  if (wallet.source === "simulation") {
    return `Wallet: cluster simulation ${cluster}. Not a live wallet.`;
  }
  const key = wallet.publicKey ?? "(no public key)";
  return `Wallet: connected ${key}. Cluster ${cluster}.`;
}
