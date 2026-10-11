import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPhase1Session } from "../src/app/phase1Session";
import { settleUiAction, thrownReason } from "../src/app/uiCall";
import { PRODUCT } from "../src/copy";
import type { PreviewEvaluation } from "../src/domain/evaluate";
import { DEVNET_GENESIS_HASH } from "../src/domain/networkAuthority";
import { emptySigningSession } from "../src/domain/signingSession";
import {
  blockhashRpc,
  fakeSign,
  freshProbe,
  genesisRpc,
  PHANTOM_WALLET,
  preparedAllow,
} from "./phase1/helpers";

describe("sign path refusals stay visible", () => {
  it("shows a reason for each early return and does not keep the Phantom waiting note", async () => {
    const { evaluation, form } = await preparedAllow();
    const now = 10_000;

    const idle = createPhase1Session(host(evaluation, form, now));
    await idle.sign();
    expect(idle.session.readiness).toBe("failed");
    expect(idle.session.note).toBe("No prepared transfer is ready to sign.");
    expect(idle.session.signed).toBeNull();

    const missing = createPhase1Session({
      ...host(evaluation, form, now),
      getEvaluation: () => null,
    });
    await missing.prepare();
    expect(missing.session.readiness).toBe("failed");
    expect(missing.session.note).toBe("No constraint result is available to prepare.");

    let releasePrepare: (hash: string) => void = () => undefined;
    let openPrepare: () => void = () => undefined;
    const prepareGate = new Promise<void>((resolve) => {
      openPrepare = resolve;
    });
    const preparing = createPhase1Session({
      ...host(evaluation, form, now),
      genesisRpc: () => ({
        getGenesisHash: () =>
          new Promise<string>((resolve) => {
            openPrepare();
            releasePrepare = resolve;
          }),
      }),
    });
    const preparingTask = preparing.prepare();
    await prepareGate;
    expect(preparing.session.readiness).toBe("preparing");
    await preparing.sign();
    expect(preparing.session.note).toBe("Prepare is still running.");
    expect(preparing.session.readiness).toBe("preparing");
    releasePrepare(DEVNET_GENESIS_HASH);
    await preparingTask;
    expect(preparing.session.readiness).toBe("ready");

    let genesisCalls = 0;
    let releaseSign: (hash: string) => void = () => undefined;
    let openSign: () => void = () => undefined;
    const signGate = new Promise<void>((resolve) => {
      openSign = resolve;
    });
    const signing = createPhase1Session({
      ...host(evaluation, form, now),
      genesisRpc: () => ({
        getGenesisHash: () => {
          genesisCalls += 1;
          if (genesisCalls === 1) {
            return Promise.resolve(DEVNET_GENESIS_HASH);
          }
          return new Promise<string>((resolve) => {
            openSign();
            releaseSign = resolve;
          });
        },
      }),
      sign: async (transaction) => fakeSign(transaction),
    });
    await signing.prepare();
    expect(signing.session.readiness).toBe("ready");
    const signTask = signing.sign();
    await signGate;
    expect(signing.session.readiness).toBe("signing");
    expect(signing.session.note).toBe("Waiting for Phantom signTransaction.");
    await signing.sign();
    expect(signing.session.note).toBe("A sign attempt is already in progress.");
    expect(signing.inFlight).toBe(true);
    releaseSign(DEVNET_GENESIS_HASH);
    await signTask;
    expect(signing.session.readiness).toBe("signed");
    expect(signing.session.note).toBe("Signed locally. Not broadcast.");
    expect(signing.session.signed).not.toBeNull();

    let current: PreviewEvaluation | null = evaluation;
    const flipping = createPhase1Session({
      ...host(evaluation, form, now),
      getEvaluation: () => current,
      sign: async () => {
        throw new Error("constraint refusal must not reach Phantom");
      },
    });
    await flipping.prepare();
    current = { ...evaluation, decision: "DENY", constraintResult: "REFUSE" };
    await flipping.sign();
    expect(flipping.session.readiness).toBe("failed");
    expect(flipping.session.note).toBe("constraint result is not ALLOW");
    expect(flipping.session.signed).toBeNull();

    const dropped = createPhase1Session(host(evaluation, form, now));
    await dropped.prepare();
    dropped.drop("form changed; signing readiness is unavailable");
    await dropped.sign();
    expect(dropped.session.readiness).toBe("unavailable");
    expect(dropped.session.note).toBe("form changed; signing readiness is unavailable");

    let exploded = false;
    const drawing = createPhase1Session({
      ...host(evaluation, form, now),
      draw: async () => {
        if (exploded) {
          throw new Error("draw exploded");
        }
      },
      sign: async () => {
        throw new Error("draw failure must not reach Phantom");
      },
    });
    await drawing.prepare();
    exploded = true;
    await drawing.sign();
    expect(drawing.session.readiness).toBe("failed");
    expect(drawing.session.note).toBe("Sign failed: draw exploded");
    expect(drawing.session.signed).toBeNull();

    const thrown = createPhase1Session({
      ...host(evaluation, form, now),
      getForm: () => {
        throw new Error("form reader broke");
      },
    });
    await thrown.prepare();
    expect(thrown.session.readiness).toBe("failed");
    expect(thrown.session.note).toBe("Prepare failed: form reader broke");
  });

  it("records a reason when a UI promise rejects", async () => {
    expect(thrownReason("Sign failed", new Error("wallet closed"))).toBe("Sign failed: wallet closed");
    expect(thrownReason("Prepare failed", "nope")).toBe("Prepare failed.");
    const reasons: string[] = [];
    settleUiAction(Promise.reject(new Error("dropped")), "Sign failed", (reason) => {
      reasons.push(reason);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(reasons).toEqual(["Sign failed: dropped"]);

    const main = readFileSync("src/main.ts", "utf8");
    expect(main).not.toMatch(/void runtime\.sign\(\)/);
    expect(main).not.toMatch(/void runtime\.prepare\(\)/);
    expect(main).toContain("settleUiAction");
    expect(emptySigningSession().note.length).toBeGreaterThan(0);
    expect(PRODUCT.preparedExpired).not.toContain("\u2014");
    expect(PRODUCT.signHint).toBe("Sign within about a minute of Prepare.");
  });
});

function host(
  evaluation: PreviewEvaluation,
  form: Awaited<ReturnType<typeof preparedAllow>>["form"],
  now: number,
) {
  return {
    getWallet: () => PHANTOM_WALLET,
    getForm: () => form,
    getEvaluation: () => evaluation,
    draw: async () => undefined,
    readProviderPublicKey: () => PHANTOM_WALLET.publicKey,
    sign: async () => {
      throw new Error("this sign path must not reach Phantom");
    },
    genesisRpc: () => genesisRpc().rpc,
    blockhashSource: () => blockhashRpc().rpc,
    blockhashProbe: () => freshProbe(),
    timeoutMs: 1_000,
    nowMs: () => now,
  };
}
