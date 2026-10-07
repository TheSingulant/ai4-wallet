import { PublicKey, type Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { PHASE1_BOUNDARIES } from "../src/domain/boundaries";
import { bytesEqual } from "../src/domain/canonical";
import { buildLegacySolTransfer, exactTransaction } from "../src/domain/nativeTransfer";
import { signIfGated } from "../src/domain/signingSession";
import { DEVNET_GENESIS_HASH } from "../src/domain/networkAuthority";
import { DISCONNECTED_WALLET } from "../src/domain/types";
import {
  BLOCKHASH_A,
  BLOCKHASH_B,
  fakeSign,
  FEE_PAYER,
  freshProbe,
  genesisRpc,
  PHANTOM_WALLET,
  preparedAllow,
  pubkey,
  walletWith,
} from "./phase1/helpers";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

describe("Phantom signTransaction gates", () => {
  it("signs the prepared transaction once and does not broadcast", async () => {
    const { session, form } = await preparedAllow();
    const prepared = session.prepared!;
    const expected = exactTransaction(prepared);
    let seen: Transaction | null = null;
    const calls: string[] = [];
    const genesis = {
      async getGenesisHash() {
        calls.push("genesis");
        return DEVNET_GENESIS_HASH;
      },
    };
    const outcome = await signIfGated({
      session,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesis,
      blockhashProbe: freshProbe(),
      sign: async (transaction) => {
        calls.push("sign");
        seen = transaction;
        return fakeSign(transaction);
      },
    });
    expect(calls).toEqual(["genesis", "sign"]);
    expect(outcome.phantomCalled).toBe(true);
    expect(seen).not.toBeNull();
    expect(bytesEqual(seen!.serializeMessage(), prepared.messageBytes)).toBe(true);
    expect(seen).not.toBe(expected);
    expect(outcome.session.readiness).toBe("signed");
    expect(outcome.session.signed?.broadcast).toBe(false);
    expect(outcome.session.signed?.signature.byteLength).toBe(64);
    expect(outcome.session.signed?.signedBytes.byteLength).toBeGreaterThan(0);
    expect(outcome.session.signed?.messageSha256).toBe(prepared.messageSha256);
    expect(PHASE1_BOUNDARIES.broadcastImplemented).toBe(false);
    expect(PHASE1_BOUNDARIES.signAndSendUsed).toBe(false);
    expect(PHASE1_BOUNDARIES.phantomSignMethod).toBe("signTransaction");

    const again = await signIfGated({
      session: outcome.session,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesis,
      blockhashProbe: freshProbe(),
      sign: async () => {
        throw new Error("second signature is not allowed from signed");
      },
    });
    expect(again.phantomCalled).toBe(false);
    expect(again.session.readiness).toBe("signed");
  });

  it("does not sign a reconstructed transaction with the same fields", async () => {
    const { session, form } = await preparedAllow();
    const prepared = session.prepared!;
    const lookalike = buildLegacySolTransfer({
      feePayer: new PublicKey(FEE_PAYER),
      destination: new PublicKey(prepared.binding.destination),
      lamports: prepared.binding.lamports,
      blockhash: BLOCKHASH_A,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    });
    expect(lookalike).not.toBe(exactTransaction(prepared));
    let seen: Transaction | null = null;
    const outcome = await signIfGated({
      session,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: freshProbe(),
      sign: async (transaction) => {
        seen = transaction;
        return fakeSign(transaction);
      },
    });
    expect(outcome.phantomCalled).toBe(true);
    expect(seen).not.toBeNull();
    expect(bytesEqual(seen!.serializeMessage(), prepared.messageBytes)).toBe(true);
    expect(seen).not.toBe(exactTransaction(prepared));
    expect(seen).not.toBe(lookalike);
  });

  it("does not call Phantom when readiness is not ready", async () => {
    const { session, form } = await preparedAllow();
    const calls: string[] = [];
    const outcome = await signIfGated({
      session: { ...session, readiness: "unavailable" },
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: {
        async getGenesisHash() {
          calls.push("genesis");
          return DEVNET_GENESIS_HASH;
        },
      },
      blockhashProbe: freshProbe(),
      sign: async () => {
        calls.push("sign");
        throw new Error("should not sign");
      },
    });
    expect(outcome.phantomCalled).toBe(false);
    expect(calls).toEqual([]);
    expect(outcome.session.prepared).toBe(session.prepared);
  });

  it("does not call Phantom when the wallet disconnected or the pubkey changed", async () => {
    const { session, form } = await preparedAllow();
    const sign = async () => {
      throw new Error("should not sign");
    };
    const disconnected = await signIfGated({
      session,
      wallet: DISCONNECTED_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: freshProbe(),
      sign,
    });
    expect(disconnected.phantomCalled).toBe(false);
    expect(disconnected.session.readiness).toBe("unavailable");
    expect(disconnected.session.prepared).toBeNull();

    const other = await signIfGated({
      session,
      wallet: walletWith(pubkey(6)),
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: freshProbe(),
      sign,
    });
    expect(other.phantomCalled).toBe(false);
    expect(other.session.readiness).toBe("unavailable");
    expect(other.session.prepared).toBeNull();
  });

  it("rechecks genesis immediately before sign and does not reuse the prepare-time result", async () => {
    const { session, form } = await preparedAllow();
    expect(session.genesis?.ok).toBe(true);
    let calls = 0;
    const outcome = await signIfGated({
      session,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: {
        async getGenesisHash() {
          calls += 1;
          return MAINNET_GENESIS;
        },
      },
      blockhashProbe: {
        isBlockhashValid: async () => {
          throw new Error("blockhash probe should not run after a genesis mismatch");
        },
        getBlockHeight: async () => 1,
      },
      sign: async () => {
        throw new Error("should not sign");
      },
    });
    expect(calls).toBe(1);
    expect(outcome.phantomCalled).toBe(false);
    expect(outcome.session.readiness).toBe("unavailable");
    expect(outcome.session.prepared).toBeNull();
    expect(outcome.session.genesis?.ok).toBe(false);
    expect(session.prepared?.blockhash).toBe(BLOCKHASH_A);
  });

  it("clears readiness and does not call Phantom when the message hash changes", async () => {
    const { session, form } = await preparedAllow();
    const prepared = session.prepared!;
    exactTransaction(prepared)!.recentBlockhash = BLOCKHASH_B;
    let signed = false;
    const outcome = await signIfGated({
      session,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: freshProbe(),
      sign: async () => {
        signed = true;
        throw new Error("should not sign");
      },
    });
    expect(signed).toBe(false);
    expect(outcome.phantomCalled).toBe(false);
    expect(outcome.session.readiness).toBe("unavailable");
    expect(outcome.session.prepared).toBeNull();
    expect(prepared.messageSha256).not.toBe("");
    expect(prepared.blockhash).toBe(BLOCKHASH_A);
  });

  it("records a local failure when Phantom rejects the request", async () => {
    const { session, form } = await preparedAllow();
    const outcome = await signIfGated({
      session,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: freshProbe(),
      sign: async () => {
        throw new Error("user dismissed");
      },
    });
    expect(outcome.phantomCalled).toBe(true);
    expect(outcome.session.readiness).toBe("failed");
    expect(outcome.session.signed).toBeNull();
    expect(outcome.session.prepared).toBe(session.prepared);

    const retry = await signIfGated({
      session: outcome.session,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: freshProbe(),
      sign: async () => {
        throw new Error("failed is not ready");
      },
    });
    expect(retry.phantomCalled).toBe(false);
    expect(retry.session.readiness).toBe("failed");
  });

  it("does not sign when the form no longer matches the prepared binding", async () => {
    const { session, form } = await preparedAllow();
    const outcome = await signIfGated({
      session,
      wallet: PHANTOM_WALLET,
      form: { ...form, amount: "0.002" },
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: freshProbe(),
      sign: async () => {
        throw new Error("should not sign");
      },
    });
    expect(outcome.phantomCalled).toBe(false);
    expect(outcome.session.readiness).toBe("unavailable");
    expect(outcome.session.prepared).toBeNull();
  });
});
