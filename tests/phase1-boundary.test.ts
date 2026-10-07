import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PHASE0_BOUNDARIES, PHASE1_BOUNDARIES } from "../src/domain/boundaries";

describe("Phase 1 hard bans", () => {
  it("does not enable mainnet, broadcast, send, WalletConnect, MetaMask, custody, or production Verify", () => {
    const root = join(process.cwd(), "src");
    const files = walk(root).filter((file) => file.endsWith(".ts"));
    const combined = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(combined).not.toContain("api.mainnet-beta.solana.com");
    expect(combined).not.toContain("api.mainnet.solana.com");
    expect(combined).not.toContain("clusterApiUrl");
    expect(combined).not.toContain("provider.cluster");
    expect(combined).not.toContain("signAndSendTransaction");
    expect(combined).not.toContain("signAllTransactions");
    expect(combined).not.toContain("signMessage");
    expect(combined).not.toContain("sendRawTransaction");
    expect(combined).not.toContain("sendAndConfirmTransaction");
    expect(combined).not.toContain("sendTransaction");
    expect(combined).not.toContain("WalletConnect");
    expect(combined).not.toContain("MetaMask");
    expect(combined).not.toContain("localStorage");
    expect(combined).not.toContain("sessionStorage");
    expect(combined).not.toContain("indexedDB");
    expect(combined).not.toMatch(/\bstaking\b/i);
    expect(combined).not.toMatch(/\bswaps?\b/i);
    expect(PHASE0_BOUNDARIES).toEqual({
      mainnetEnabled: false,
      privateKeyHandling: false,
      serverSigning: false,
      liveSigningEnabled: false,
      verifyProductionCalled: false,
      unsWrites: false,
      deployed: false,
    });
    expect(PHASE1_BOUNDARIES.mainnetEnabled).toBe(false);
    expect(PHASE1_BOUNDARIES.broadcastImplemented).toBe(false);
    expect(PHASE1_BOUNDARIES.signAndSendUsed).toBe(false);
    expect(PHASE1_BOUNDARIES.serverSigning).toBe(false);
    expect(PHASE1_BOUNDARIES.custody).toBe(false);
    expect(PHASE1_BOUNDARIES.deployed).toBe(false);
    expect(PHASE1_BOUNDARIES.transactionFormat).toBe("legacy");
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
    } else {
      out.push(path);
    }
  }
  return out;
}
