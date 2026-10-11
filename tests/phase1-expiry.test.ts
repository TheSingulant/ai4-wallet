// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createPhase1Session } from "../src/app/phase1Session";
import { PRODUCT } from "../src/copy";
import { APP_DEVNET_RPC_URL } from "../src/domain/genesisLive";
import { DEVNET_GENESIS_HASH } from "../src/domain/networkAuthority";
import { expirePreparedSession, PREPARED_TRANSFER_TTL_MS } from "../src/domain/signingSession";
import { DEVNET_TRANSFER } from "../src/fixtures/preview";
import { renderApp, type RenderHandlers } from "../src/ui/render";
import {
  BLOCKHASH_A,
  BLOCKHASH_B,
  freshProbe,
  genesisRpc,
  PHANTOM_WALLET,
  preparedAllow,
} from "./phase1/helpers";

const handlers: RenderHandlers = {
  onConnect: () => undefined,
  onDisconnect: () => undefined,
  onFixture: () => undefined,
  onMainnet: () => undefined,
  onDevnetIntent: () => undefined,
  onRecheck: () => undefined,
};

describe("prepared transfer expiry", () => {
  it("shows a countdown, then Prepared transfer expired, and does not refresh the blockhash", async () => {
    const { evaluation, form, session: sample } = await preparedAllow();
    let now = sample.prepared?.preparedAtMs ?? 0;
    const hashes = [BLOCKHASH_A, BLOCKHASH_B];
    const blockhash = {
      calls: [] as string[],
      async getLatestBlockhash() {
        blockhash.calls.push("blockhash");
        const next = hashes[blockhash.calls.length - 1] ?? BLOCKHASH_B;
        return { blockhash: next, lastValidBlockHeight: 100 + blockhash.calls.length };
      },
    };
    let probes = 0;
    const runtime = createPhase1Session({
      getWallet: () => PHANTOM_WALLET,
      getForm: () => form,
      getEvaluation: () => evaluation,
      draw: async () => undefined,
      readProviderPublicKey: () => PHANTOM_WALLET.publicKey,
      sign: async () => {
        throw new Error("expired transfer must not be signed");
      },
      genesisRpc: () => genesisRpc().rpc,
      blockhashSource: () => blockhash,
      blockhashProbe: () => {
        probes += 1;
        return freshProbe();
      },
      timeoutMs: 1_000,
      nowMs: () => now,
    });

    await runtime.prepare();
    expect(runtime.session.readiness).toBe("ready");
    expect(blockhash.calls).toEqual(["blockhash"]);
    const prepared = runtime.session.prepared;
    expect(prepared?.blockhash).toBe(BLOCKHASH_A);

    const root = document.createElement("div");
    renderPrepared(root, evaluation, form, runtime.session, now);
    expect(root.querySelector("[data-testid='prepared-expiry']")?.textContent).toBe(
      "Prepared transfer expires in 1:00.",
    );
    expect(root.querySelector("[data-testid='sign-hint']")?.textContent).toBe(PRODUCT.signHint);
    expect(root.querySelector("[data-testid='phase1-readiness']")?.textContent).toBe(
      "Signing status: Ready.",
    );
    expect(root.querySelector<HTMLButtonElement>("[data-testid='sign-transaction']")?.disabled).toBe(
      false,
    );

    now += 30_000;
    renderPrepared(root, evaluation, form, runtime.session, now);
    expect(root.querySelector("[data-testid='prepared-expiry']")?.textContent).toBe(
      "Prepared transfer expires in 0:30.",
    );
    expect(runtime.expireIfDue()).toBe(false);
    expect(prepared?.blockhash).toBe(BLOCKHASH_A);

    now += PREPARED_TRANSFER_TTL_MS;
    expect(runtime.expireIfDue()).toBe(true);
    expect(blockhash.calls).toEqual(["blockhash"]);
    expect(probes).toBe(0);
    expect(runtime.session.readiness).toBe("failed");
    expect(runtime.session.note).toBe(PRODUCT.preparedExpired);
    expect(runtime.session.prepared).toBe(prepared);
    expect(runtime.session.prepared?.blockhash).toBe(BLOCKHASH_A);
    expect(runtime.session.signed).toBeNull();

    renderPrepared(root, evaluation, form, runtime.session, now);
    expect(root.querySelector("[data-testid='phase1-readiness']")?.textContent).toBe(
      "Signing status: Failed.",
    );
    expect(root.querySelector("[data-testid='phase1-note']")?.textContent).toBe(PRODUCT.preparedExpired);
    expect(root.querySelector("[data-testid='prepared-expiry']")?.textContent).toBe(PRODUCT.preparedExpired);
    expect(root.querySelector("[data-testid='blockhash']")?.textContent).toContain(BLOCKHASH_A);
    expect(root.querySelector<HTMLButtonElement>("[data-testid='sign-transaction']")?.disabled).toBe(
      true,
    );

    await runtime.sign();
    expect(blockhash.calls).toEqual(["blockhash"]);
    expect(probes).toBe(0);
    expect(runtime.session.note).toBe(PRODUCT.preparedExpired);
    expect(runtime.session.prepared?.blockhash).toBe(BLOCKHASH_A);

    await runtime.prepare();
    expect(blockhash.calls).toEqual(["blockhash", "blockhash"]);
    expect(runtime.session.readiness).toBe("ready");
    expect(runtime.session.prepared).not.toBe(prepared);
    expect(runtime.session.prepared?.blockhash).toBe(BLOCKHASH_B);
    expect(prepared?.blockhash).toBe(BLOCKHASH_A);
    expect(DEVNET_GENESIS_HASH).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  });

  it("does not edit the prepared record when the pure expiry helper runs", async () => {
    const { session } = await preparedAllow();
    const prepared = session.prepared!;
    const unchanged = expirePreparedSession(session, prepared.preparedAtMs + PREPARED_TRANSFER_TTL_MS - 1);
    expect(unchanged).toBe(session);
    const expired = expirePreparedSession(session, prepared.preparedAtMs + PREPARED_TRANSFER_TTL_MS);
    expect(expired.readiness).toBe("failed");
    expect(expired.note).toBe("Prepared transfer expired. Prepare again.");
    expect(expired.prepared).toBe(prepared);
    expect(prepared.blockhash).toBe(BLOCKHASH_A);
  });
});

function renderPrepared(
  root: HTMLElement,
  evaluation: Awaited<ReturnType<typeof preparedAllow>>["evaluation"],
  form: Awaited<ReturnType<typeof preparedAllow>>["form"],
  session: Awaited<ReturnType<typeof preparedAllow>>["session"],
  nowMs: number,
): void {
  renderApp(
    root,
    {
      evaluation,
      wallet: PHANTOM_WALLET,
      detection: { adapterId: "phantom", present: true },
      connectNote: "Phantom returned a public key. No signature was requested.",
      form,
      phase1: { session, rpcUrl: APP_DEVNET_RPC_URL, nowMs },
    },
    handlers,
  );
}
