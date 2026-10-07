import { Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { evaluatePreview, type PreviewEvaluation } from "../../src/domain/evaluate";
import { DEVNET_GENESIS_HASH } from "../../src/domain/networkAuthority";
import {
  runPrepare,
  type PrepareInput,
  type SigningGeneration,
  type SigningSession,
  type TransferForm,
} from "../../src/domain/signingSession";
import type { BlockhashFreshness } from "../../src/solana/devnetConnection";
import { DISCONNECTED_WALLET, type WalletSnapshot } from "../../src/domain/types";
import { CONSTRAINT_FIXTURES, DEVNET_TRANSFER } from "../../src/fixtures/preview";

export function pubkey(byte: number): string {
  return new PublicKey(Uint8Array.from({ length: 32 }, () => byte)).toBase58();
}

/** Deterministic fee payer. Signatures in tests are produced with this keypair. */
export const TEST_PAYER = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 4));
export const FEE_PAYER = TEST_PAYER.publicKey.toBase58();
export const BLOCKHASH_A = pubkey(9);
export const BLOCKHASH_B = pubkey(10);

export const PHANTOM_WALLET: WalletSnapshot = Object.freeze({
  status: "connected",
  publicKey: FEE_PAYER,
  source: "phantom",
});

export function walletWith(publicKey: string, source: WalletSnapshot["source"] = "phantom"): WalletSnapshot {
  return Object.freeze({
    status: "connected",
    publicKey,
    source,
  });
}

export async function allowEvaluation(
  wallet: WalletSnapshot = PHANTOM_WALLET,
): Promise<PreviewEvaluation> {
  return evaluatePreview({
    intent: DEVNET_TRANSFER,
    constraint: CONSTRAINT_FIXTURES.allow,
    wallet,
  });
}

export function formFrom(evaluation: PreviewEvaluation, patch: Partial<TransferForm> = {}): TransferForm {
  return {
    amount: evaluation.approvedBinding?.amount_sol ?? DEVNET_TRANSFER.amount,
    destination: evaluation.approvedBinding?.destination ?? DEVNET_TRANSFER.destination,
    network: "devnet",
    serializedTx: evaluation.serializedTx ?? "",
    ...patch,
  };
}

export function genesisRpc(hash: string | (() => Promise<string>) = DEVNET_GENESIS_HASH) {
  const calls: string[] = [];
  const getGenesisHash =
    typeof hash === "function"
      ? async () => {
          calls.push("genesis");
          return hash();
        }
      : async () => {
          calls.push("genesis");
          return hash;
        };
  return { calls, rpc: { getGenesisHash } };
}

export function blockhashRpc(blockhash = BLOCKHASH_A, lastValidBlockHeight = 100) {
  const calls: string[] = [];
  return {
    calls,
    rpc: {
      async getLatestBlockhash() {
        calls.push("blockhash");
        return { blockhash, lastValidBlockHeight };
      },
    },
  };
}

/**
 * Live guards a direct signIfGated caller must pass.
 * Production code does not use this helper. Overrides in a test win when spread first.
 */
export function stableGuards(
  session: SigningSession,
  form: TransferForm,
  wallet: WalletSnapshot = PHANTOM_WALLET,
): {
  generation: SigningGeneration;
  attemptGeneration: number;
  liveSession: () => SigningSession;
  liveForm: () => TransferForm;
  liveWallet: () => WalletSnapshot;
  constraintStillAllow: () => boolean;
  readProviderPublicKey: () => string | null;
} {
  const generation: SigningGeneration = { current: session.generation };
  return {
    generation,
    attemptGeneration: generation.current,
    liveSession: () => session,
    liveForm: () => form,
    liveWallet: () => wallet,
    constraintStillAllow: () => true,
    readProviderPublicKey: () => (wallet.status === "connected" ? wallet.publicKey : null),
  };
}

export function freshProbe(height = 50): BlockhashFreshness {
  return {
    isBlockhashValid: async () => true,
    getBlockHeight: async () => height,
  };
}

export async function preparedAllow(
  patch: Partial<PrepareInput> = {},
): Promise<{ evaluation: PreviewEvaluation; session: SigningSession; form: TransferForm }> {
  const evaluation = await allowEvaluation(patch.wallet ?? PHANTOM_WALLET);
  const form = patch.form ?? formFrom(evaluation);
  const genesis = genesisRpc();
  const blockhash = blockhashRpc();
  const session = await runPrepare({
    decision: evaluation.decision,
    constraintResult: evaluation.constraintResult,
    binding: evaluation.approvedBinding,
    bindingSha256: evaluation.approvedBinding?.sha256 ?? null,
    serializedTx: evaluation.serializedTx,
    wallet: evaluation.wallet,
    form,
    genesisRpc: genesis.rpc,
    blockhashRpc: blockhash.rpc,
    nowMs: 1_700_000_000_000,
    ...patch,
  });
  return { evaluation, session, form };
}

export function fakeSign(transaction: Transaction): Transaction {
  const payer = transaction.feePayer;
  if (!payer || !payer.equals(TEST_PAYER.publicKey)) {
    throw new Error("fee payer does not match the test signer");
  }
  transaction.partialSign(TEST_PAYER);
  return transaction;
}

export { DEVNET_GENESIS_HASH, DISCONNECTED_WALLET };
