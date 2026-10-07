import { PRODUCT } from "../copy";
import { isDevnet } from "../domain/devnetGuard";
import type { PreviewEvaluation } from "../domain/evaluate";
import type { Phase0SigningReadiness, WalletSnapshot } from "../domain/types";
import type { VerifyStatus } from "../domain/verify";

export interface AppView {
  title: string;
  subtitle: string;
  custody: string;
  verify: string;
  networkLine: string;
  requiredLine: string;
  walletLine: string;
  constraintLine: string;
  reasons: readonly string[];
  bindingLines: string[];
  signingLine: string;
  phase: string;
}

export function verifyLine(verify: VerifyStatus): string {
  return `Identity verification: ${verify.label} / ${verify.detail}`;
}

export function signingReadinessLine(readiness: Phase0SigningReadiness): string {
  if (readiness === "not_ready") {
    return PRODUCT.signingNotReady;
  }
  return PRODUCT.signingUnavailable;
}

export function constraintResultLine(evaluation: PreviewEvaluation): string {
  if (evaluation.constraintResult) {
    return `Constraint result: ${evaluation.constraintResult}`;
  }
  return `Transaction control: ${evaluation.decision}`;
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

  const guardNote = isDevnet(evaluation.networkDisplay) ? "" : " Phase 0 requires DevNet.";
  const networkLabel =
    evaluation.networkDisplay === "DevNet" ? "Solana DevNet" : evaluation.networkDisplay;

  return {
    title: PRODUCT.title,
    subtitle: PRODUCT.subtitle,
    custody: PRODUCT.custody,
    verify: verifyLine(evaluation.verify),
    networkLine: `Network: ${networkLabel}.${guardNote}`.trim(),
    requiredLine: "Required network: DevNet.",
    walletLine: walletLine(wallet),
    constraintLine: constraintResultLine(evaluation),
    reasons: evaluation.reasons,
    bindingLines,
    signingLine: signingReadinessLine(evaluation.signingReadiness),
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
    view.constraintLine,
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
  const key = wallet.publicKey ?? "(no public key)";
  if (wallet.source === "simulation") {
    return `Wallet: connected ${key}. Simulated identity. Not a live wallet.`;
  }
  return `Wallet: connected ${key}.`;
}
