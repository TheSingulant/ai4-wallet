import type { Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { createPhantomIdentityBinding } from "../src/app/phantomIdentity";
import { createPhase1Session } from "../src/app/phase1Session";
import { DEVNET_GENESIS_HASH } from "../src/domain/networkAuthority";
import { signIfGated, type SignInput, type SigningGeneration } from "../src/domain/signingSession";
import type { WalletSnapshot } from "../src/domain/types";
import { readPhantomPublicKey, signTransaction } from "../src/wallet/phantom";
import type { WalletScope } from "../src/wallet/types";
import {
  blockhashRpc,
  fakeSign,
  FEE_PAYER,
  freshProbe,
  genesisRpc,
  PHANTOM_WALLET,
  preparedAllow,
  pubkey,
  stableGuards,
} from "./phase1/helpers";

const OMITTED_GUARDS = [
  "generation",
  "attemptGeneration",
  "liveSession",
  "liveForm",
  "liveWallet",
  "constraintStillAllow",
  "readProviderPublicKey",
] as const;

describe("phase-1 signing races", () => {
  it("fails closed before signTransaction when a live guard is missing", async () => {
    const { session, form } = await preparedAllow();
    expect(session.readiness).toBe("ready");
    for (const omitted of OMITTED_GUARDS) {
      let phantom = false;
      const input: Record<string, unknown> = {
        ...stableGuards(session, form),
        session,
        wallet: PHANTOM_WALLET,
        form,
        genesisRpc: {
          async getGenesisHash() {
            throw new Error(`${omitted} must fail closed before RPC`);
          },
        },
        blockhashProbe: freshProbe(),
        sign: async () => {
          phantom = true;
          throw new Error(`${omitted} must not call signTransaction`);
        },
      };
      delete input[omitted];
      const outcome = await signIfGated(input as unknown as SignInput);
      expect(phantom, omitted).toBe(false);
      expect(outcome.phantomCalled, omitted).toBe(false);
      expect(outcome.session, omitted).toBe(session);
      expect(outcome.session.readiness, omitted).toBe("ready");
    }
  });

  it("aborts when the generation changes during the blockhash await", async () => {
    const { session, form } = await preparedAllow();
    const generation: SigningGeneration = { current: session.generation };
    const attemptGeneration = generation.current;
    let releaseBlockhash: (valid: boolean) => void = () => undefined;
    let blockhashStarted: () => void = () => undefined;
    const blockhashAwaiting = new Promise<void>((resolve) => {
      blockhashStarted = resolve;
    });
    let phantom = false;
    const signing = signIfGated({
      ...stableGuards(session, form),
      session,
      wallet: PHANTOM_WALLET,
      form,
      generation,
      attemptGeneration,
      liveSession: () => session,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: {
        isBlockhashValid: () =>
          new Promise<boolean>((resolve) => {
            blockhashStarted();
            releaseBlockhash = resolve;
          }),
        getBlockHeight: async () => 50,
      },
      sign: async () => {
        phantom = true;
        throw new Error("stale generation must not reach Phantom");
      },
    });
    await blockhashAwaiting;
    generation.current += 1;
    releaseBlockhash(true);
    const outcome = await signing;
    expect(phantom).toBe(false);
    expect(outcome.phantomCalled).toBe(false);
    expect(outcome.session.readiness).not.toBe("signed");
    expect(outcome.session.readiness).toBe("unavailable");
    expect(outcome.session.note).toMatch(/invalidated/);

    let retryPhantom = false;
    const retry = await signIfGated({
      ...stableGuards(session, form),
      session,
      wallet: PHANTOM_WALLET,
      form,
      generation,
      attemptGeneration,
      liveSession: () => session,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: freshProbe(),
      sign: async () => {
        retryPhantom = true;
        throw new Error("old session must not proceed");
      },
    });
    expect(retryPhantom).toBe(false);
    expect(retry.phantomCalled).toBe(false);
    expect(retry.session.readiness).not.toBe("signed");
    expect(session.readiness).toBe("ready");
  });

  it("aborts when the live form changes during an in-flight sign without drop", async () => {
    const { session, form } = await preparedAllow();
    const generation: SigningGeneration = { current: session.generation };
    const attemptGeneration = generation.current;
    let liveForm = form;
    let releaseGenesis: (hash: string) => void = () => undefined;
    let genesisStarted: () => void = () => undefined;
    const genesisAwaiting = new Promise<void>((resolve) => {
      genesisStarted = resolve;
    });
    let phantom = false;
    const signing = signIfGated({
      ...stableGuards(session, form),
      session,
      wallet: PHANTOM_WALLET,
      form,
      generation,
      attemptGeneration,
      liveSession: () => session,
      liveForm: () => liveForm,
      genesisRpc: {
        getGenesisHash() {
          genesisStarted();
          return new Promise<string>((resolve) => {
            releaseGenesis = resolve;
          });
        },
      },
      blockhashProbe: {
        isBlockhashValid: async () => {
          throw new Error("form recheck must abort before the blockhash probe");
        },
        getBlockHeight: async () => 50,
      },
      sign: async () => {
        phantom = true;
        throw new Error("edited form must not reach Phantom");
      },
    });
    await genesisAwaiting;
    liveForm = { ...form, amount: "0.002" };
    expect(generation.current).toBe(attemptGeneration);
    releaseGenesis(DEVNET_GENESIS_HASH);
    const outcome = await signing;
    expect(phantom).toBe(false);
    expect(outcome.phantomCalled).toBe(false);
    expect(outcome.session.readiness).not.toBe("signed");
    expect(outcome.session.readiness).toBe("unavailable");
    expect(outcome.session.note).toMatch(/form/);
    expect(generation.current).toBe(attemptGeneration);
  });

  it("accountChanged during an in-flight sign invalidates the session before Phantom", async () => {
    const harness = await readyPhantomSign();
    const signing = harness.runtime.sign();
    await harness.gate;
    expect(harness.runtime.inFlight).toBe(true);
    const generation = harness.runtime.generation;
    harness.fake.setPublicKey(pubkey(6));
    harness.fake.emit("accountChanged", { toString: () => pubkey(6) });
    expect(harness.runtime.generation).toBe(generation + 1);
    expect(harness.runtime.session.readiness).toBe("unavailable");
    expect(harness.runtime.session.prepared).toBeNull();
    expect(harness.wallet().publicKey).toBe(pubkey(6));
    harness.release(DEVNET_GENESIS_HASH);
    await signing;
    expect(harness.fake.signCalls).toBe(0);
    expect(harness.runtime.session.readiness).not.toBe("signed");
    const later = harness.runtime.sign();
    await later;
    expect(harness.fake.signCalls).toBe(0);
  });

  it("disconnect during an in-flight sign invalidates the session before Phantom", async () => {
    const harness = await readyPhantomSign();
    const signing = harness.runtime.sign();
    await harness.gate;
    expect(harness.runtime.inFlight).toBe(true);
    const generation = harness.runtime.generation;
    harness.fake.setPublicKey(null);
    harness.fake.emit("disconnect");
    expect(harness.runtime.generation).toBe(generation + 1);
    expect(harness.runtime.session.readiness).toBe("unavailable");
    expect(harness.runtime.session.prepared).toBeNull();
    expect(harness.wallet().status).toBe("disconnected");
    harness.release(DEVNET_GENESIS_HASH);
    await signing;
    expect(harness.fake.signCalls).toBe(0);
    expect(harness.runtime.session.readiness).not.toBe("signed");
    await harness.runtime.sign();
    expect(harness.fake.signCalls).toBe(0);
  });

  it("keeps one listener per Phantom event across rebind and removes them on teardown", async () => {
    const fake = createFakePhantom(FEE_PAYER);
    let wallet: WalletSnapshot = PHANTOM_WALLET;
    let drops = 0;
    const identity = createPhantomIdentityBinding({
      scope: fake.scope,
      getWallet: () => wallet,
      setWallet: (next) => {
        wallet = next;
      },
      setConnectNote: () => undefined,
      drop: () => {
        drops += 1;
      },
    });
    identity.bind();
    identity.bind();
    expect(fake.listenerCount("accountChanged")).toBe(1);
    expect(fake.listenerCount("disconnect")).toBe(1);
    identity.unbind();
    identity.bind();
    expect(fake.listenerCount("accountChanged")).toBe(1);
    expect(fake.listenerCount("disconnect")).toBe(1);
    fake.emit("accountChanged", { toString: () => pubkey(6) });
    fake.emit("disconnect");
    expect(drops).toBe(2);
    identity.unbind();
    expect(fake.listenerCount("accountChanged")).toBe(0);
    expect(fake.listenerCount("disconnect")).toBe(0);
    fake.emit("accountChanged", { toString: () => pubkey(7) });
    fake.emit("disconnect");
    expect(drops).toBe(2);
  });
});

function deferredGenesis() {
  let release: (hash: string) => void = () => undefined;
  let opened: () => void = () => undefined;
  return {
    rpc: {
      getGenesisHash: () =>
        new Promise<string>((resolve) => {
          opened();
          release = resolve;
        }),
    },
    arm() {
      const gate = new Promise<void>((resolve) => {
        opened = resolve;
      });
      return {
        gate,
        finish(hash: string) {
          release(hash);
        },
      };
    },
  };
}

function createFakePhantom(initial: string | null) {
  const listeners = new Map<string, Set<(value?: unknown) => void>>();
  let publicKey = initial;
  let signCalls = 0;
  const provider = {
    isPhantom: true as const,
    get publicKey() {
      return publicKey === null ? null : { toString: () => publicKey };
    },
    connect: async () => ({
      publicKey: publicKey === null ? null : { toString: () => publicKey },
    }),
    on(event: string, handler: (value?: unknown) => void) {
      const set = listeners.get(event) ?? new Set<(value?: unknown) => void>();
      set.add(handler);
      listeners.set(event, set);
    },
    off(event: string, handler: (value?: unknown) => void) {
      listeners.get(event)?.delete(handler);
    },
    signTransaction(transaction: Transaction) {
      signCalls += 1;
      return Promise.resolve(fakeSign(transaction));
    },
    emit(event: string, value?: unknown) {
      for (const handler of [...(listeners.get(event) ?? [])]) {
        handler(value);
      }
    },
  };
  const scope: WalletScope = {
    getProvider: () => provider,
  };
  return {
    scope,
    get signCalls() {
      return signCalls;
    },
    setPublicKey(next: string | null) {
      publicKey = next;
    },
    emit: provider.emit,
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

async function readyPhantomSign() {
  const { evaluation, form } = await preparedAllow();
  const fake = createFakePhantom(FEE_PAYER);
  const genesis = deferredGenesis();
  let wallet: WalletSnapshot = PHANTOM_WALLET;
  const runtime = createPhase1Session({
    getWallet: () => wallet,
    getForm: () => form,
    getEvaluation: () => evaluation,
    draw: async () => undefined,
    readProviderPublicKey: () => readPhantomPublicKey(fake.scope),
    sign: (transaction) => signTransaction(fake.scope, transaction),
    genesisRpc: () => genesis.rpc,
    blockhashSource: () => blockhashRpc().rpc,
    blockhashProbe: () => freshProbe(),
    timeoutMs: 1_000,
  });
  const identity = createPhantomIdentityBinding({
    scope: fake.scope,
    getWallet: () => wallet,
    setWallet: (next) => {
      wallet = next;
    },
    setConnectNote: () => undefined,
    drop: (note) => runtime.drop(note),
  });
  identity.bind();
  expect(fake.listenerCount("accountChanged")).toBe(1);
  expect(fake.listenerCount("disconnect")).toBe(1);
  const preparing = genesis.arm();
  const prepared = runtime.prepare();
  await preparing.gate;
  preparing.finish(DEVNET_GENESIS_HASH);
  await prepared;
  expect(runtime.session.readiness).toBe("ready");
  const inflight = genesis.arm();
  return {
    fake,
    runtime,
    wallet: () => wallet,
    gate: inflight.gate,
    release: inflight.finish,
  };
}
