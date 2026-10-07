import { parseSolAmount } from "./amount";
import { validateSolanaAddress } from "./address";
import {
  canonicalBindingJson,
  canonicalSerializedTx,
  sha256Hex,
} from "./canonical";
import { devnetGuardReason, displayNetwork, isDevnet } from "./devnetGuard";
import { resolveSigningReadiness, sameWalletSession } from "./signingReadiness";
import {
  PHASE0_ACTION,
  PHASE0_ASSET,
  REQUIRED_NETWORK,
  type ApprovedBinding,
  type ApprovedFormState,
  type ConstraintDecision,
  type ConstraintFixture,
  type FrozenAllow,
  type NormalizedIntent,
  type Phase0SigningReadiness,
  type ProductDecision,
  type TransferIntentInput,
  type WalletSnapshot,
} from "./types";
import { readVerifyStatus, type VerifyStatus } from "./verify";

export interface PreviewInput {
  intent: TransferIntentInput;
  constraint: ConstraintFixture;
  wallet: WalletSnapshot;
}

export interface PreviewEvaluation {
  /** Fixture outcome. Null when transaction control fails closed before the fixture is applied. */
  constraintResult: ConstraintDecision | null;
  decision: ProductDecision;
  signingReadiness: Phase0SigningReadiness;
  reasons: readonly string[];
  networkDisplay: string;
  requiredNetwork: typeof REQUIRED_NETWORK;
  intent: NormalizedIntent | null;
  approvedBinding: Readonly<ApprovedBinding & { sha256: string }> | null;
  serializedTx: string | null;
  serializedTxSha256: string | null;
  /** Always null in Phase 0. Readiness is signingReadiness, not this field. */
  signingHandoff: null;
  verify: VerifyStatus;
  wallet: WalletSnapshot;
  frozen: FrozenAllow | null;
}

export interface RecheckInput {
  network: string;
  amount: string;
  destination: string;
  serializedTx: string;
}

/** Current wallet session. Recheck does not reuse a stale readiness value. */
export interface RecheckSession {
  readonly wallet: WalletSnapshot;
}

export async function evaluatePreview(input: PreviewInput): Promise<PreviewEvaluation> {
  const networkDisplay = displayNetwork(input.intent.network);
  const reasons: string[] = [];

  if (input.intent.requestCustody) {
    reasons.push("custody was requested; Phase 0 is non-custodial");
  }
  if (input.intent.serverSign) {
    reasons.push("server signing was requested");
  }
  if (input.intent.serverBroadcast) {
    reasons.push("server broadcast was requested");
  }

  if (input.intent.asset.trim().toUpperCase() !== PHASE0_ASSET) {
    reasons.push("asset is not native SOL");
  }
  if (input.intent.action.trim().toLowerCase() !== PHASE0_ACTION) {
    reasons.push("action is not transfer");
  }

  const networkReason = devnetGuardReason(input.intent.network);
  if (networkReason) {
    reasons.push(networkReason);
  }

  const amount = parseSolAmount(input.intent.amount);
  if (!amount.ok) {
    reasons.push(amount.reason);
  }
  const destination = validateSolanaAddress(input.intent.destination);
  if (!destination.ok) {
    reasons.push(destination.reason);
  }

  if (reasons.length > 0 || !amount.ok || !destination.ok || networkReason) {
    return denied({
      reasons,
      networkDisplay,
      wallet: input.wallet,
    });
  }

  const intent: NormalizedIntent = Object.freeze({
    network: REQUIRED_NETWORK,
    asset: PHASE0_ASSET,
    action: PHASE0_ACTION,
    amount_sol: amount.value.amount_sol,
    lamports: amount.value.lamports,
    destination: destination.address,
  });

  if (input.constraint.decision === "REVISE" || input.constraint.decision === "REFUSE") {
    return present({
      constraintResult: input.constraint.decision,
      decision: input.constraint.decision,
      signingReadiness: "unavailable",
      reasons: [...input.constraint.reasons],
      networkDisplay,
      requiredNetwork: REQUIRED_NETWORK,
      intent,
      approvedBinding: null,
      serializedTx: null,
      serializedTxSha256: null,
      signingHandoff: null,
      verify: readVerifyStatus(),
      wallet: input.wallet,
      frozen: null,
    });
  }

  if (input.constraint.decision !== "ALLOW") {
    return denied({
      reasons: ["constraint fixture decision is not recognized; fail closed"],
      networkDisplay,
      wallet: input.wallet,
    });
  }

  const frozen = await freezeAllow(intent, input.wallet);
  const signingReadiness = resolveSigningReadiness({
    decision: "ALLOW",
    wallet: input.wallet,
    sessionUnchanged: true,
  });
  const allowReasons = [...input.constraint.reasons];
  if (signingReadiness === "unavailable") {
    allowReasons.push("wallet is disconnected; signing readiness is unavailable");
  } else {
    allowReasons.push("Phase 0 does not request signatures");
  }

  return allowed({
    reasons: allowReasons,
    networkDisplay,
    wallet: input.wallet,
    intent,
    frozen,
    signingReadiness,
  });
}

export async function recheckAfterAllow(
  frozen: FrozenAllow,
  next: RecheckInput,
  session: RecheckSession,
): Promise<PreviewEvaluation> {
  const recomputed = await sha256Hex(canonicalBindingJson(frozen.binding));
  if (recomputed !== frozen.sha256) {
    return mutationDeny(
      ["approved binding hash does not match the canonical payload"],
      next.network,
      session.wallet,
    );
  }

  const reasons: string[] = [];
  if (!isDevnet(next.network) || normalizeCompare(next.network) !== frozen.binding.network) {
    reasons.push("network changed after ALLOW");
  }

  const amount = parseSolAmount(next.amount);
  if (
    !amount.ok ||
    amount.value.amount_sol !== frozen.binding.amount_sol ||
    amount.value.lamports !== frozen.binding.lamports
  ) {
    reasons.push("amount changed after ALLOW");
  }

  const destination = validateSolanaAddress(next.destination);
  if (!destination.ok || destination.address !== frozen.binding.destination) {
    reasons.push("destination changed after ALLOW");
  }

  const rebuilt = canonicalSerializedTx(frozen.binding);
  if (rebuilt !== frozen.serializedTx || next.serializedTx !== rebuilt) {
    reasons.push("serialized transaction changed after ALLOW");
  }

  const serializedHash = await sha256Hex(rebuilt);
  if (serializedHash !== frozen.serializedTxSha256) {
    reasons.push("serialized transaction hash does not match the ALLOW snapshot");
  }

  if (reasons.length > 0) {
    return mutationDeny(reasons, next.network, session.wallet);
  }

  const sessionUnchanged = sameWalletSession(frozen.session, session.wallet);
  const signingReadiness = resolveSigningReadiness({
    decision: "ALLOW",
    wallet: session.wallet,
    sessionUnchanged,
  });
  const allowReasons = ["binding still matches the ALLOW snapshot"];
  if (!sessionUnchanged) {
    allowReasons.push("wallet session changed after ALLOW; signing readiness is unavailable");
  } else if (signingReadiness === "unavailable") {
    allowReasons.push("wallet is disconnected; signing readiness is unavailable");
  } else {
    allowReasons.push("Phase 0 does not request signatures");
  }

  return allowed({
    reasons: allowReasons,
    networkDisplay: displayNetwork(next.network),
    wallet: session.wallet,
    intent: Object.freeze({
      network: REQUIRED_NETWORK,
      asset: PHASE0_ASSET,
      action: PHASE0_ACTION,
      amount_sol: frozen.binding.amount_sol,
      lamports: frozen.binding.lamports,
      destination: frozen.binding.destination,
    }),
    frozen,
    signingReadiness,
  });
}

async function freezeAllow(intent: NormalizedIntent, wallet: WalletSnapshot): Promise<FrozenAllow> {
  const binding = Object.freeze({
    network: intent.network,
    asset: intent.asset,
    action: intent.action,
    amount_sol: intent.amount_sol,
    lamports: intent.lamports,
    destination: intent.destination,
  });
  const serializedTx = canonicalSerializedTx(binding);
  const [bindingHash, serializedHash] = await Promise.all([
    sha256Hex(canonicalBindingJson(binding)),
    sha256Hex(serializedTx),
  ]);
  const approvedForm: ApprovedFormState = Object.freeze({
    amount: binding.amount_sol,
    destination: binding.destination,
    network: binding.network,
    serializedTx,
  });
  const session: WalletSnapshot = Object.freeze({
    status: wallet.status,
    publicKey: wallet.publicKey,
    source: wallet.source,
  });
  return Object.freeze({
    binding,
    sha256: bindingHash,
    serializedTx,
    serializedTxSha256: serializedHash,
    approvedForm,
    session,
  });
}

function normalizeCompare(value: string): string {
  return value.trim().toLowerCase();
}

function denied(args: {
  reasons: string[];
  networkDisplay: string;
  wallet: WalletSnapshot;
  intent?: NormalizedIntent | null;
}): PreviewEvaluation {
  return present({
    constraintResult: null,
    decision: "DENY",
    signingReadiness: "unavailable",
    reasons: args.reasons.length > 0 ? args.reasons : ["fail closed"],
    networkDisplay: args.networkDisplay,
    requiredNetwork: REQUIRED_NETWORK,
    intent: args.intent ?? null,
    approvedBinding: null,
    serializedTx: null,
    serializedTxSha256: null,
    signingHandoff: null,
    verify: readVerifyStatus(),
    wallet: args.wallet,
    frozen: null,
  });
}

function allowed(args: {
  reasons: string[];
  networkDisplay: string;
  wallet: WalletSnapshot;
  intent: NormalizedIntent;
  frozen: FrozenAllow;
  signingReadiness: Phase0SigningReadiness;
}): PreviewEvaluation {
  return present({
    constraintResult: "ALLOW",
    decision: "ALLOW",
    signingReadiness: args.signingReadiness,
    reasons: args.reasons,
    networkDisplay: args.networkDisplay,
    requiredNetwork: REQUIRED_NETWORK,
    intent: args.intent,
    approvedBinding: {
      network: args.frozen.binding.network,
      asset: args.frozen.binding.asset,
      action: args.frozen.binding.action,
      amount_sol: args.frozen.binding.amount_sol,
      lamports: args.frozen.binding.lamports,
      destination: args.frozen.binding.destination,
      sha256: args.frozen.sha256,
    },
    serializedTx: args.frozen.serializedTx,
    serializedTxSha256: args.frozen.serializedTxSha256,
    signingHandoff: null,
    verify: readVerifyStatus(),
    wallet: args.wallet,
    frozen: args.frozen,
  });
}

function mutationDeny(
  reasons: string[],
  network: string,
  wallet: WalletSnapshot,
): PreviewEvaluation {
  return present({
    constraintResult: null,
    decision: "DENY",
    signingReadiness: "unavailable",
    reasons,
    networkDisplay: displayNetwork(network),
    requiredNetwork: REQUIRED_NETWORK,
    intent: null,
    approvedBinding: null,
    serializedTx: null,
    serializedTxSha256: null,
    signingHandoff: null,
    verify: readVerifyStatus(),
    wallet,
    frozen: null,
  });
}

function present(evaluation: PreviewEvaluation): PreviewEvaluation {
  const wallet: WalletSnapshot = Object.freeze({
    status: evaluation.wallet.status,
    publicKey: evaluation.wallet.publicKey,
    source: evaluation.wallet.source,
  });
  const approvedBinding =
    evaluation.approvedBinding === null
      ? null
      : Object.freeze({
          network: evaluation.approvedBinding.network,
          asset: evaluation.approvedBinding.asset,
          action: evaluation.approvedBinding.action,
          amount_sol: evaluation.approvedBinding.amount_sol,
          lamports: evaluation.approvedBinding.lamports,
          destination: evaluation.approvedBinding.destination,
          sha256: evaluation.approvedBinding.sha256,
        });
  const intent =
    evaluation.intent === null
      ? null
      : Object.freeze({
          network: evaluation.intent.network,
          asset: evaluation.intent.asset,
          action: evaluation.intent.action,
          amount_sol: evaluation.intent.amount_sol,
          lamports: evaluation.intent.lamports,
          destination: evaluation.intent.destination,
        });
  return Object.freeze({
    constraintResult: evaluation.constraintResult,
    decision: evaluation.decision,
    signingReadiness: evaluation.signingReadiness,
    reasons: Object.freeze([...evaluation.reasons]),
    networkDisplay: evaluation.networkDisplay,
    requiredNetwork: evaluation.requiredNetwork,
    intent,
    approvedBinding,
    serializedTx: evaluation.serializedTx,
    serializedTxSha256: evaluation.serializedTxSha256,
    signingHandoff: null,
    verify: Object.freeze({ ...evaluation.verify }),
    wallet,
    frozen: evaluation.frozen,
  });
}
