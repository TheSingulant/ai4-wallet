import { describe, expect, it } from "vitest";
import { exactTransaction } from "../src/domain/nativeTransfer";
import { runPrepare, signIfGated } from "../src/domain/signingSession";
import {
  allowEvaluation,
  BLOCKHASH_A,
  BLOCKHASH_B,
  blockhashRpc,
  fakeSign,
  formFrom,
  freshProbe,
  genesisRpc,
  PHANTOM_WALLET,
  preparedAllow,
  stableGuards,
} from "./phase1/helpers";

describe("blockhash expiry", () => {
  it("changes the message hash when the blockhash changes and does not edit the old record", async () => {
    const evaluation = await allowEvaluation();
    const form = formFrom(evaluation);
    const first = await runPrepare({
      decision: evaluation.decision,
      constraintResult: evaluation.constraintResult,
      binding: evaluation.approvedBinding,
      bindingSha256: evaluation.approvedBinding?.sha256 ?? null,
      serializedTx: evaluation.serializedTx,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashRpc: blockhashRpc(BLOCKHASH_A, 100).rpc,
      nowMs: 10,
    });
    const second = await runPrepare({
      decision: evaluation.decision,
      constraintResult: evaluation.constraintResult,
      binding: evaluation.approvedBinding,
      bindingSha256: evaluation.approvedBinding?.sha256 ?? null,
      serializedTx: evaluation.serializedTx,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashRpc: blockhashRpc(BLOCKHASH_B, 200).rpc,
      nowMs: 20,
    });
    expect(first.readiness).toBe("ready");
    expect(second.readiness).toBe("ready");
    expect(first.prepared?.blockhash).toBe(BLOCKHASH_A);
    expect(second.prepared?.blockhash).toBe(BLOCKHASH_B);
    expect(first.prepared?.messageSha256).not.toBe(second.prepared?.messageSha256);
    expect(first.prepared).not.toBe(second.prepared);
  });

  it.each([
    ["rpc reports the blockhash invalid", { valid: false, height: 50 }, /no longer valid/],
    ["block height is past the last valid height", { valid: true, height: 101 }, /expired/],
  ] as const)("does not replace the blockhash when %s", async (_label, probe, reason) => {
    const { session, form } = await preparedAllow();
    const prepared = session.prepared!;
    const transaction = exactTransaction(prepared)!;
    const outcome = await signIfGated({
      ...stableGuards(session, form),
      session,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: {
        isBlockhashValid: async () => probe.valid,
        getBlockHeight: async () => probe.height,
      },
      sign: async () => {
        throw new Error("expired state must not be signed");
      },
    });
    expect(outcome.phantomCalled).toBe(false);
    expect(outcome.session.readiness).toBe("unavailable");
    expect(outcome.session.prepared).toBeNull();
    expect(outcome.session.note).toMatch(reason);
    expect(prepared.blockhash).toBe(BLOCKHASH_A);
    expect(transaction.recentBlockhash).toBe(BLOCKHASH_A);
    expect(prepared.lastValidBlockHeight).toBe(100);
  });

  it("fail closed when the blockhash check times out or throws", async () => {
    const { session, form } = await preparedAllow();
    const timedOut = await signIfGated({
      ...stableGuards(session, form),
      session,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: {
        isBlockhashValid: () => new Promise(() => undefined),
        getBlockHeight: async () => 1,
      },
      timeoutMs: 20,
      sign: async () => {
        throw new Error("should not sign");
      },
    });
    expect(timedOut.phantomCalled).toBe(false);
    expect(timedOut.session.readiness).toBe("unavailable");
    expect(timedOut.session.note).toMatch(/timed out/);
    expect(session.prepared?.blockhash).toBe(BLOCKHASH_A);

    const failed = await signIfGated({
      ...stableGuards(session, form),
      session,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: {
        isBlockhashValid: async () => {
          throw new Error("rpc down");
        },
        getBlockHeight: async () => 1,
      },
      sign: async () => {
        throw new Error("should not sign");
      },
    });
    expect(failed.phantomCalled).toBe(false);
    expect(failed.session.prepared).toBeNull();
    expect(failed.session.note).toMatch(/failed/);
  });

  it("rebuilds a new prepared state and refuses the expired one", async () => {
    const { session, form, evaluation } = await preparedAllow();
    const oldPrepared = session.prepared!;
    const expired = await signIfGated({
      ...stableGuards(session, form),
      session,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: {
        isBlockhashValid: async () => false,
        getBlockHeight: async () => 1,
      },
      sign: async () => {
        throw new Error("should not sign");
      },
    });
    expect(expired.session.prepared).toBeNull();

    const rebuilt = await runPrepare({
      decision: evaluation.decision,
      constraintResult: evaluation.constraintResult,
      binding: evaluation.approvedBinding,
      bindingSha256: evaluation.approvedBinding?.sha256 ?? null,
      serializedTx: evaluation.serializedTx,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashRpc: blockhashRpc(BLOCKHASH_B, 250).rpc,
      nowMs: 30,
    });
    expect(rebuilt.readiness).toBe("ready");
    expect(rebuilt.prepared?.blockhash).toBe(BLOCKHASH_B);
    expect(rebuilt.prepared?.messageSha256).not.toBe(oldPrepared.messageSha256);
    expect(oldPrepared.blockhash).toBe(BLOCKHASH_A);

    const refused = await signIfGated({
      ...stableGuards(rebuilt, form),
      session: rebuilt,
      candidate: oldPrepared,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: freshProbe(),
      sign: async () => {
        throw new Error("old state must not be signed");
      },
    });
    expect(refused.phantomCalled).toBe(false);
    expect(refused.session).toBe(rebuilt);
    expect(refused.session.prepared?.blockhash).toBe(BLOCKHASH_B);

    const signed = await signIfGated({
      ...stableGuards(rebuilt, form),
      session: rebuilt,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: freshProbe(200),
      sign: async (transaction) => fakeSign(transaction),
    });
    expect(signed.phantomCalled).toBe(true);
    expect(signed.session.readiness).toBe("signed");
    expect(exactTransaction(rebuilt.prepared!)).toBeDefined();
    expect(signed.session.signed?.broadcast).toBe(false);
  });

  it("treats the last valid block height as inclusive", async () => {
    const { session, form } = await preparedAllow();
    const outcome = await signIfGated({
      ...stableGuards(session, form),
      session,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: freshProbe(100),
      sign: async (transaction) => fakeSign(transaction),
    });
    expect(outcome.phantomCalled).toBe(true);
    expect(outcome.session.readiness).toBe("signed");
  });
});
