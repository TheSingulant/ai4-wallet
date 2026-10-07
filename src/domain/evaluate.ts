import { parseSolAmount } from "./amount";
import { validateSolanaAddress } from "./address";
import {
  canonicalBindingJson,
  canonicalSerializedTx,
  sha256Hex,
} from "./canonical";
import { devnetGuardReason, displayNetwork, isDevnet } from "./devnetGuard";
import {
  PHASE0_ACTION,
  PHASE0_ASSET,
  REQUIRED_NETWORK,
  type ApprovedBinding,
  type ConstraintFixture,
  type FrozenAllow,
  type NormalizedIntent,
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
  decision: ProductDecision;
  reasons: string[];
  networkDisplay: string;
  walletNetworkDisplay: string;
  requiredNetwork: typeof REQUIRED_NETWORK;
  intent: NormalizedIntent | null;
  approvedBinding: (ApprovedBinding & { sha256: string }) | null;
  serializedTx: string | null;
  serializedTxSha256: string | null;
  /** Always null in Phase 0. Non-ALLOW results must not gain a signing handoff later by accident. */
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

export async function evaluatePreview(input: PreviewInput): Promise<PreviewEvaluation> {
  const networkDisplay = displayNetwork(input.intent.network);
  const walletNetworkDisplay =
    input.wallet.status === "disconnected"
      ? "disconnected"
      : displayNetwork(input.wallet.network ?? "");
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

  if (
    reasons.length > 0 ||
    !amount.ok ||
    !destination.ok ||
    networkReason
  ) {
    return denied({
      reasons,
      networkDisplay,
      walletNetworkDisplay,
      wallet: input.wallet,
    });
  }

  const intent: NormalizedIntent = {
    network: REQUIRED_NETWORK,
    asset: PHASE0_ASSET,
    action: PHASE0_ACTION,
    amount_sol: amount.value.amount_sol,
    lamports: amount.value.lamports,
    destination: destination.address,
  };

  if (input.constraint.decision === "REVISE" || input.constraint.decision === "REFUSE") {
    return {
      decision: input.constraint.decision,
      reasons: [...input.constraint.reasons],
      networkDisplay,
      walletNetworkDisplay,
      requiredNetwork: REQUIRED_NETWORK,
      intent,
      approvedBinding: null,
      serializedTx: null,
      serializedTxSha256: null,
      signingHandoff: null,
      verify: readVerifyStatus(),
      wallet: input.wallet,
      frozen: null,
    };
  }

  if (input.constraint.decision !== "ALLOW") {
    return denied({
      reasons: ["constraint fixture decision is not recognized; fail closed"],
      networkDisplay,
      walletNetworkDisplay,
      wallet: input.wallet,
    });
  }

  const frozen = await freezeAllow(intent);
  const allowReasons = [...input.constraint.reasons];

  if (input.wallet.status !== "connected") {
    allowReasons.push("wallet is disconnected; signing handoff is not available");
    return allowed({
      reasons: allowReasons,
      networkDisplay,
      walletNetworkDisplay,
      wallet: input.wallet,
      intent,
      frozen,
    });
  }

  if (!input.wallet.network || !isDevnet(input.wallet.network)) {
    return denied({
      reasons: ["wallet cluster is not devnet; fail closed"],
      networkDisplay,
      walletNetworkDisplay,
      wallet: input.wallet,
      intent,
    });
  }

  allowReasons.push("wallet cluster is devnet");
  allowReasons.push("Phase 0 does not request a signature");
  return allowed({
    reasons: allowReasons,
    networkDisplay,
    walletNetworkDisplay,
    wallet: input.wallet,
    intent,
    frozen,
  });
}

export async function recheckAfterAllow(
  frozen: FrozenAllow,
  next: RecheckInput,
): Promise<PreviewEvaluation> {
  const recomputed = await sha256Hex(canonicalBindingJson(frozen.binding));
  if (recomputed !== frozen.sha256) {
    return mutationDeny(
      ["approved binding hash does not match the canonical payload"],
      next.network,
    );
  }

  const reasons: string[] = [];
  if (!isDevnet(next.network) || normalizeCompare(next.network) !== frozen.binding.network) {
    reasons.push("network changed after ALLOW");
  }

  const amount = parseSolAmount(next.amount);
  if (!amount.ok || amount.value.amount_sol !== frozen.binding.amount_sol || amount.value.lamports !== frozen.binding.lamports) {
    reasons.push("amount changed after ALLOW");
  }

  const destination = validateSolanaAddress(next.destination);
  if (!destination.ok || destination.address !== frozen.binding.destination) {
    reasons.push("destination changed after ALLOW");
  }

  if (next.serializedTx !== frozen.serializedTx) {
    reasons.push("serialized transaction changed after ALLOW");
  }

  const serializedHash = await sha256Hex(frozen.serializedTx);
  if (serializedHash !== frozen.serializedTxSha256) {
    reasons.push("serialized transaction hash does not match the ALLOW snapshot");
  }

  if (reasons.length > 0) {
    return mutationDeny(reasons, next.network);
  }

  return {
    decision: "ALLOW",
    reasons: ["binding still matches the ALLOW snapshot", "Phase 0 does not request a signature"],
    networkDisplay: displayNetwork(next.network),
    walletNetworkDisplay: displayNetwork(next.network),
    requiredNetwork: REQUIRED_NETWORK,
    intent: {
      network: REQUIRED_NETWORK,
      asset: PHASE0_ASSET,
      action: PHASE0_ACTION,
      amount_sol: frozen.binding.amount_sol,
      lamports: frozen.binding.lamports,
      destination: frozen.binding.destination,
    },
    approvedBinding: { ...frozen.binding, sha256: frozen.sha256 },
    serializedTx: frozen.serializedTx,
    serializedTxSha256: frozen.serializedTxSha256,
    signingHandoff: null,
    verify: readVerifyStatus(),
    wallet: {
      status: "disconnected",
      publicKey: null,
      network: null,
      source: "none",
    },
    frozen,
  };
}

async function freezeAllow(intent: NormalizedIntent): Promise<FrozenAllow> {
  const binding: ApprovedBinding = {
    network: intent.network,
    asset: intent.asset,
    action: intent.action,
    amount_sol: intent.amount_sol,
    lamports: intent.lamports,
    destination: intent.destination,
  };
  const serializedTx = canonicalSerializedTx(binding);
  const [bindingHash, serializedHash] = await Promise.all([
    sha256Hex(canonicalBindingJson(binding)),
    sha256Hex(serializedTx),
  ]);
  return {
    binding,
    sha256: bindingHash,
    serializedTx,
    serializedTxSha256: serializedHash,
  };
}

function normalizeCompare(value: string): string {
  return value.trim().toLowerCase();
}

function denied(args: {
  reasons: string[];
  networkDisplay: string;
  walletNetworkDisplay: string;
  wallet: WalletSnapshot;
  intent?: NormalizedIntent | null;
}): PreviewEvaluation {
  return {
    decision: "DENY",
    reasons: args.reasons.length > 0 ? args.reasons : ["fail closed"],
    networkDisplay: args.networkDisplay,
    walletNetworkDisplay: args.walletNetworkDisplay,
    requiredNetwork: REQUIRED_NETWORK,
    intent: args.intent ?? null,
    approvedBinding: null,
    serializedTx: null,
    serializedTxSha256: null,
    signingHandoff: null,
    verify: readVerifyStatus(),
    wallet: args.wallet,
    frozen: null,
  };
}

function allowed(args: {
  reasons: string[];
  networkDisplay: string;
  walletNetworkDisplay: string;
  wallet: WalletSnapshot;
  intent: NormalizedIntent;
  frozen: FrozenAllow;
}): PreviewEvaluation {
  return {
    decision: "ALLOW",
    reasons: args.reasons,
    networkDisplay: args.networkDisplay,
    walletNetworkDisplay: args.walletNetworkDisplay,
    requiredNetwork: REQUIRED_NETWORK,
    intent: args.intent,
    approvedBinding: { ...args.frozen.binding, sha256: args.frozen.sha256 },
    serializedTx: args.frozen.serializedTx,
    serializedTxSha256: args.frozen.serializedTxSha256,
    signingHandoff: null,
    verify: readVerifyStatus(),
    wallet: args.wallet,
    frozen: args.frozen,
  };
}

function mutationDeny(reasons: string[], network: string): PreviewEvaluation {
  return {
    decision: "DENY",
    reasons,
    networkDisplay: displayNetwork(network),
    walletNetworkDisplay: displayNetwork(network),
    requiredNetwork: REQUIRED_NETWORK,
    intent: null,
    approvedBinding: null,
    serializedTx: null,
    serializedTxSha256: null,
    signingHandoff: null,
    verify: readVerifyStatus(),
    wallet: {
      status: "disconnected",
      publicKey: null,
      network: null,
      source: "none",
    },
    frozen: null,
  };
}
