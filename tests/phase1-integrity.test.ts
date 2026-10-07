import { Message, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { createPhase1Session } from "../src/app/phase1Session";
import { decodeBase58 } from "../src/domain/address";
import { bytesEqual } from "../src/domain/canonical";
import { APP_DEVNET_RPC_URL } from "../src/domain/genesisLive";
import { DEVNET_GENESIS_HASH } from "../src/domain/networkAuthority";
import {
  buildLegacySolTransfer,
  commitExactMessageSign,
  exactTransaction,
  isExactBlockhash,
  readSystemTransferMessage,
  SYSTEM_PROGRAM_ID,
} from "../src/domain/nativeTransfer";
import { runPrepare, signIfGated, signingControlsLocked } from "../src/domain/signingSession";
import { TimeoutError, withTimeout } from "../src/domain/timeout";
import { createDevnetRpcFetch, isAppDevnetRpcUrl } from "../src/solana/devnetConnection";
import { readPhantomPublicKey, subscribePhantomSession } from "../src/wallet/phantom";
import {
  BLOCKHASH_A,
  BLOCKHASH_B,
  blockhashRpc,
  fakeSign,
  FEE_PAYER,
  freshProbe,
  genesisRpc,
  PHANTOM_WALLET,
  preparedAllow,
  pubkey,
  stableGuards,
  TEST_PAYER,
} from "./phase1/helpers";

const SHORT_BLOCKHASH = "tVojvhToWjQ8Xvo4UPx2Xz9eRy7auyYMmZBjc2XfN";
const LONG_BLOCKHASH = "bbULHBSDmh4zRM4rKx1RyC9ZzJi3qYWq5vExqbwjXa8y";

describe("pre-sign integrity", () => {
  it("compares frozen bytes and signs that transaction before yielding", async () => {
    const { session } = await preparedAllow();
    const prepared = session.prepared!;
    const frozen = prepared.messageBytes;
    const order: string[] = [];
    const generation = { current: 1 };
    const result = commitExactMessageSign({
      prepared,
      generation,
      attemptGeneration: 1,
      livePrepared: () => prepared,
      formMatches: () => true,
      constraintAllows: () => true,
      providerPublicKey: () => prepared.feePayer,
      walletPublicKey: () => prepared.feePayer,
      sign: (transaction) => {
        order.push("sign");
        exactTransaction(prepared)!.recentBlockhash = BLOCKHASH_B;
        expect(bytesEqual(transaction.serializeMessage(), frozen)).toBe(true);
        expect(transaction).not.toBe(exactTransaction(prepared));
        return fakeSign(transaction);
      },
    });
    order.push("returned");
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.ok).toBe(true);
    await Promise.resolve();
    expect(order).toEqual(["sign", "returned"]);
  });

  it("does not sign when the sealed transaction changes during an RPC await", async () => {
    const { session, form } = await preparedAllow();
    const prepared = session.prepared!;
    let phantom = false;
    const outcome = await signIfGated({
      ...stableGuards(session, form),
      session,
      wallet: PHANTOM_WALLET,
      form,
      readProviderPublicKey: () => FEE_PAYER,
      genesisRpc: {
        async getGenesisHash() {
          exactTransaction(prepared)!.recentBlockhash = BLOCKHASH_B;
          return DEVNET_GENESIS_HASH;
        },
      },
      blockhashProbe: freshProbe(),
      sign: async () => {
        phantom = true;
        throw new Error("mutated message must not reach Phantom");
      },
    });
    expect(phantom).toBe(false);
    expect(outcome.phantomCalled).toBe(false);
    expect(outcome.session.readiness).toBe("unavailable");
    expect(outcome.session.prepared).toBeNull();
  });

  it("does not sign when a readiness callback mutates the sealed transaction", async () => {
    const { session, form } = await preparedAllow();
    const prepared = session.prepared!;
    let phantom = false;
    const outcome = await signIfGated({
      ...stableGuards(session, form),
      session,
      wallet: PHANTOM_WALLET,
      form,
      readProviderPublicKey: () => FEE_PAYER,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: freshProbe(),
      onReadiness: () => {
        exactTransaction(prepared)!.recentBlockhash = BLOCKHASH_B;
      },
      sign: async () => {
        phantom = true;
        throw new Error("callback mutation must not reach Phantom");
      },
    });
    expect(phantom).toBe(false);
    expect(outcome.phantomCalled).toBe(false);
    expect(outcome.session.readiness).toBe("unavailable");
  });

  it("aborts before Phantom when the generation changes during an await", async () => {
    const { session, form } = await preparedAllow();
    const generation = { current: 4 };
    let phantom = false;
    const outcome = await signIfGated({
      ...stableGuards(session, form),
      session,
      wallet: PHANTOM_WALLET,
      form,
      generation,
      attemptGeneration: 4,
      readProviderPublicKey: () => FEE_PAYER,
      genesisRpc: {
        async getGenesisHash() {
          generation.current = 5;
          return DEVNET_GENESIS_HASH;
        },
      },
      blockhashProbe: freshProbe(),
      sign: async () => {
        phantom = true;
        throw new Error("stale generation must not reach Phantom");
      },
    });
    expect(phantom).toBe(false);
    expect(outcome.phantomCalled).toBe(false);
    expect(outcome.session.readiness).toBe("unavailable");
    expect(outcome.session.note).toMatch(/invalidated/);
  });

  it("aborts when the provider public key changes during an await", async () => {
    const { session, form } = await preparedAllow();
    let providerKey: string | null = FEE_PAYER;
    let phantom = false;
    const outcome = await signIfGated({
      ...stableGuards(session, form),
      session,
      wallet: PHANTOM_WALLET,
      form,
      readProviderPublicKey: () => providerKey,
      genesisRpc: {
        async getGenesisHash() {
          providerKey = pubkey(6);
          return DEVNET_GENESIS_HASH;
        },
      },
      blockhashProbe: freshProbe(),
      sign: async () => {
        phantom = true;
        throw new Error("changed account must not reach Phantom");
      },
    });
    expect(phantom).toBe(false);
    expect(outcome.phantomCalled).toBe(false);
    expect(outcome.session.readiness).toBe("unavailable");
    expect(outcome.session.note).toMatch(/fee payer/);
  });

  it("rejects a returned signature that does not verify", async () => {
    const { session, form } = await preparedAllow();
    const outcome = await signIfGated({
      ...stableGuards(session, form),
      session,
      wallet: PHANTOM_WALLET,
      form,
      readProviderPublicKey: () => FEE_PAYER,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: freshProbe(),
      sign: async (transaction) => {
        const payer = transaction.feePayer;
        if (!payer) {
          throw new Error("missing fee payer");
        }
        transaction.addSignature(payer, Buffer.alloc(64, 7));
        return transaction;
      },
    });
    expect(outcome.phantomCalled).toBe(true);
    expect(outcome.session.readiness).toBe("failed");
    expect(outcome.session.signed).toBeNull();
    expect(outcome.session.note).toMatch(/signature/i);
    expect(outcome.session.note).not.toMatch(/Signed locally/);
  });

  it("fails closed on an RPC redirect and aborts a timed-out fetch", async () => {
    const urls: string[] = [];
    const redirecting = createDevnetRpcFetch({
      timeoutMs: 1_000,
      fetchImpl: async (input, init) => {
        urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        expect(init?.redirect).toBe("error");
        return new Response(null, {
          status: 302,
          headers: { Location: "https://api.mainnet-beta.solana.com" },
        });
      },
    });
    await expect(redirecting(APP_DEVNET_RPC_URL)).rejects.toThrow(/redirect/);
    expect(urls).toEqual([APP_DEVNET_RPC_URL]);
    expect(isAppDevnetRpcUrl("https://api.mainnet-beta.solana.com")).toBe(false);

    let aborted = false;
    const hanging = createDevnetRpcFetch({
      timeoutMs: 20,
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });
    await expect(hanging(APP_DEVNET_RPC_URL)).rejects.toThrow();
    expect(aborted).toBe(true);

    const controller = new AbortController();
    let outerAborted = false;
    const outer = createDevnetRpcFetch({
      timeoutMs: 5_000,
      signal: controller.signal,
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            outerAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });
    await expect(withTimeout(outer(APP_DEVNET_RPC_URL), 30, controller)).rejects.toBeInstanceOf(TimeoutError);
    expect(controller.signal.aborted).toBe(true);
    expect(outerAborted).toBe(true);
  });

  it("rejects blockhashes that are not 32-byte base58", async () => {
    expect(decodeBase58(SHORT_BLOCKHASH).byteLength).toBe(31);
    expect(decodeBase58(LONG_BLOCKHASH).byteLength).toBe(33);
    expect(isExactBlockhash(BLOCKHASH_A)).toBe(true);
    expect(isExactBlockhash("")).toBe(false);
    expect(isExactBlockhash(SHORT_BLOCKHASH)).toBe(false);
    expect(isExactBlockhash(LONG_BLOCKHASH)).toBe(false);
    expect(isExactBlockhash("0OIl")).toBe(false);

    const { evaluation, form } = await preparedAllow();
    for (const blockhash of ["", "0OIl", SHORT_BLOCKHASH, LONG_BLOCKHASH]) {
      const session = await runPrepare({
        decision: evaluation.decision,
        constraintResult: evaluation.constraintResult,
        binding: evaluation.approvedBinding,
        bindingSha256: evaluation.approvedBinding?.sha256 ?? null,
        serializedTx: evaluation.serializedTx,
        wallet: PHANTOM_WALLET,
        form,
        genesisRpc: genesisRpc().rpc,
        blockhashRpc: blockhashRpc(blockhash, 100).rpc,
      });
      expect(session.readiness).toBe("unavailable");
      expect(session.prepared).toBeNull();
      expect(session.note).toMatch(/32-byte base58|could not be built/);
    }
  });

  it("checks account-key order for a self-transfer", () => {
    const payer = TEST_PAYER.publicKey;
    const self = buildLegacySolTransfer({
      feePayer: payer,
      destination: payer,
      lamports: 1_000,
      blockhash: BLOCKHASH_A,
      lastValidBlockHeight: 100,
    });
    const shape = readSystemTransferMessage(self);
    expect(shape.ok).toBe(true);
    if (!shape.ok) {
      return;
    }
    expect(shape.shape.feePayer).toBe(FEE_PAYER);
    expect(shape.shape.recipient).toBe(FEE_PAYER);
    expect(shape.shape.accountKeys).toEqual([FEE_PAYER, SYSTEM_PROGRAM_ID]);
    expect(shape.shape.instructionAccounts).toEqual([FEE_PAYER, FEE_PAYER]);

    const compiled = self.compileMessage();
    const extra = new PublicKey(Uint8Array.from({ length: 32 }, () => 8));
    const system = compiled.accountKeys[1];
    const payerKey = compiled.accountKeys[0];
    const instruction = compiled.instructions[0];
    if (!system || !payerKey || !instruction) {
      throw new Error("self-transfer message was incomplete");
    }
    const tampered = new Message({
      header: compiled.header,
      accountKeys: [payerKey, extra, system],
      recentBlockhash: compiled.recentBlockhash,
      instructions: [
        {
          programIdIndex: 2,
          accounts: [0, 0],
          data: instruction.data,
        },
      ],
    });
    self.compileMessage = () => tampered;
    const rejected = readSystemTransferMessage(self);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.reason).toMatch(/self-transfer account key ordering/);
    }
  });

  it("keeps one in-flight sign and passes the prepared identity", async () => {
    const { evaluation, form } = await preparedAllow();
    let wallet = PHANTOM_WALLET;
    let currentForm = form;
    let providerKey: string | null = FEE_PAYER;
    let releaseGenesis: (hash: string) => void = () => undefined;
    let genesisGate: Promise<void> = Promise.resolve();
    let openGenesis: () => void = () => undefined;
    let phantom = 0;
    let seenMessage = false;
    const runtime = createPhase1Session({
      getWallet: () => wallet,
      getForm: () => currentForm,
      getEvaluation: () => evaluation,
      draw: async () => undefined,
      readProviderPublicKey: () => providerKey,
      sign: async (transaction) => {
        phantom += 1;
        seenMessage = bytesEqual(transaction.serializeMessage(), runtime.session.prepared?.messageBytes ?? new Uint8Array());
        return fakeSign(transaction);
      },
      genesisRpc: () => ({
        getGenesisHash: () =>
          new Promise<string>((resolve) => {
            openGenesis();
            releaseGenesis = resolve;
          }),
      }),
      blockhashSource: () => blockhashRpc().rpc,
      blockhashProbe: () => freshProbe(),
      timeoutMs: 1_000,
    });

    genesisGate = new Promise<void>((resolve) => {
      openGenesis = resolve;
    });
    const preparing = runtime.prepare();
    await genesisGate;
    releaseGenesis(DEVNET_GENESIS_HASH);
    await preparing;
    expect(runtime.session.readiness).toBe("ready");
    const prepared = runtime.session.prepared;
    expect(prepared).not.toBeNull();

    genesisGate = new Promise<void>((resolve) => {
      openGenesis = resolve;
    });
    const signing = runtime.sign();
    await genesisGate;
    expect(runtime.inFlight).toBe(true);
    expect(runtime.session.readiness).toBe("signing");
    expect(signingControlsLocked(runtime.session)).toBe(true);
    const second = runtime.sign();
    const preparedDuringSign = runtime.prepare();
    await second;
    await preparedDuringSign;
    expect(phantom).toBe(0);
    expect(runtime.session.prepared).toBe(prepared);
    expect(runtime.session.prepared?.messageSha256).toBe(prepared?.messageSha256);

    releaseGenesis(DEVNET_GENESIS_HASH);
    await signing;
    expect(phantom).toBe(1);
    expect(seenMessage).toBe(true);
    expect(runtime.session.readiness).toBe("signed");
    expect(runtime.inFlight).toBe(false);

    providerKey = pubkey(6);
    genesisGate = new Promise<void>((resolve) => {
      openGenesis = resolve;
    });
    const replaced = runtime.prepare();
    await genesisGate;
    releaseGenesis(DEVNET_GENESIS_HASH);
    await replaced;
    expect(runtime.session.readiness).toBe("ready");
    const nextPrepared = runtime.session.prepared;
    genesisGate = new Promise<void>((resolve) => {
      openGenesis = resolve;
    });
    const stale = runtime.sign();
    await genesisGate;
    providerKey = pubkey(6);
    releaseGenesis(DEVNET_GENESIS_HASH);
    await stale;
    expect(phantom).toBe(1);
    expect(runtime.session.readiness).toBe("unavailable");
    expect(runtime.session.prepared).toBeNull();
    expect(nextPrepared).not.toBeNull();
  });

  it("aborts an in-flight sign when the session generation changes", async () => {
    const { evaluation, form } = await preparedAllow();
    let releaseGenesis: (hash: string) => void = () => undefined;
    let openGenesis: () => void = () => undefined;
    let phantom = 0;
    const runtime = createPhase1Session({
      getWallet: () => PHANTOM_WALLET,
      getForm: () => form,
      getEvaluation: () => evaluation,
      draw: async () => undefined,
      readProviderPublicKey: () => FEE_PAYER,
      sign: async (transaction) => {
        phantom += 1;
        return fakeSign(transaction);
      },
      genesisRpc: () => ({
        getGenesisHash: () =>
          new Promise<string>((resolve) => {
            openGenesis();
            releaseGenesis = resolve;
          }),
      }),
      blockhashSource: () => blockhashRpc().rpc,
      blockhashProbe: () => freshProbe(),
      timeoutMs: 1_000,
    });
    let opened = new Promise<void>((resolve) => {
      openGenesis = resolve;
    });
    const preparing = runtime.prepare();
    await opened;
    releaseGenesis(DEVNET_GENESIS_HASH);
    await preparing;

    opened = new Promise<void>((resolve) => {
      openGenesis = resolve;
    });
    const signing = runtime.sign();
    await opened;
    runtime.drop("form changed; signing readiness is unavailable");
    releaseGenesis(DEVNET_GENESIS_HASH);
    await signing;
    expect(phantom).toBe(0);
    expect(runtime.session.readiness).toBe("unavailable");
    expect(runtime.session.prepared).toBeNull();
    expect(runtime.inFlight).toBe(false);
  });

  it("subscribes to accountChanged and disconnect and removes the listeners", () => {
    const listeners = new Map<string, (value?: unknown) => void>();
    let publicKey: string | null = FEE_PAYER;
    const provider = {
      isPhantom: true,
      get publicKey() {
        return publicKey === null ? null : { toString: () => publicKey };
      },
      connect: async () => ({ publicKey: { toString: () => FEE_PAYER } }),
      on(event: string, handler: (value?: unknown) => void) {
        listeners.set(event, handler);
      },
      off(event: string) {
        listeners.delete(event);
      },
    };
    const scope = {
      getProvider: () => provider,
    };
    expect(readPhantomPublicKey(scope)).toBe(FEE_PAYER);
    const events: string[] = [];
    const unsubscribe = subscribePhantomSession(scope, {
      onAccountChanged: (next) => {
        events.push(`account:${next ?? ""}`);
      },
      onDisconnect: () => {
        events.push("disconnect");
      },
    });
    listeners.get("accountChanged")?.({ toString: () => pubkey(6) });
    listeners.get("disconnect")?.();
    publicKey = null;
    expect(readPhantomPublicKey(scope)).toBeNull();
    unsubscribe();
    expect(listeners.has("accountChanged")).toBe(false);
    expect(listeners.has("disconnect")).toBe(false);
    expect(events).toEqual([`account:${pubkey(6)}`, "disconnect"]);
  });
});
