import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PHASE0_BOUNDARIES } from "../src/domain/boundaries";
import { connectPhantom, detectPhantom, listAdapters, phantomAdapter } from "../src/wallet/phantom";

const FORBIDDEN_ACCESS = [
  "secretKey",
  "privateKey",
  "signTransaction",
  "signAndSendTransaction",
  "signAllTransactions",
  "signMessage",
];

describe("Phantom adapter", () => {
  it("reports a disconnected wallet when Phantom is absent", async () => {
    const scope = { getProvider: () => undefined };
    expect(detectPhantom(scope).present).toBe(false);
    const session = await connectPhantom(scope);
    expect(session.status).toBe("disconnected");
    expect(session.publicKey).toBeNull();
    expect(session.network).toBeNull();
  });

  it("connects to a public key on the reported cluster and does not touch signing material", async () => {
    const accessed: string[] = [];
    let signCalls = 0;
    const raw = {
      isPhantom: true,
      cluster: "devnet",
      connect: async () => ({ publicKey: { toString: () => "FixturePublicKey" } }),
      secretKey: new Uint8Array(64),
      privateKey: "do-not-read",
      signTransaction: () => {
        signCalls += 1;
      },
      signAndSendTransaction: () => {
        signCalls += 1;
      },
      signAllTransactions: () => {
        signCalls += 1;
      },
      signMessage: () => {
        signCalls += 1;
      },
    };
    const provider = new Proxy(raw, {
      get(target, prop, receiver) {
        if (typeof prop === "string") {
          accessed.push(prop);
          if (FORBIDDEN_ACCESS.includes(prop)) {
            throw new Error(`adapter accessed ${prop}`);
          }
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const scope = {
      getProvider(id: string) {
        return id === "phantom" ? provider : undefined;
      },
    };
    expect(phantomAdapter.detect(scope).present).toBe(true);
    const session = await phantomAdapter.connect(scope);
    expect(session).toEqual({
      status: "connected",
      publicKey: "FixturePublicKey",
      network: "devnet",
      source: "phantom",
    });
    expect(signCalls).toBe(0);
    expect(accessed.filter((name) => FORBIDDEN_ACCESS.includes(name))).toEqual([]);
    expect(PHASE0_BOUNDARIES.privateKeyHandling).toBe(false);
  });

  it("returns disconnected when connect fails", async () => {
    const scope = {
      getProvider: () => ({
        isPhantom: true,
        connect: async () => {
          throw new Error("user dismissed");
        },
      }),
    };
    const session = await connectPhantom(scope);
    expect(session.status).toBe("disconnected");
    expect(session.publicKey).toBeNull();
  });

  it("registers only the Phantom adapter in Phase 0", () => {
    expect(listAdapters().map((adapter) => adapter.id)).toEqual(["phantom"]);
    expect(Object.keys(phantomAdapter).sort()).toEqual(["chainFamily", "connect", "detect", "id"]);
    expect("sign" in phantomAdapter).toBe(false);
  });
});

describe("source boundary", () => {
  it("does not call signing methods or read key fields", () => {
    const root = join(process.cwd(), "src");
    const files = walk(root).filter((file) => file.endsWith(".ts"));
    const pattern =
      /\.signTransaction\s*\(|\.signAndSendTransaction\s*\(|\.signAllTransactions\s*\(|\.signMessage\s*\(|\.secretKey\b|\.privateKey\b|\bmnemonic\b/;
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (pattern.test(text)) {
        hits.push(file);
      }
    }
    expect(hits).toEqual([]);
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
