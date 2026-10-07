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
  "cluster",
];

const SIGN_METHODS = [
  "signTransaction",
  "signAndSendTransaction",
  "signAllTransactions",
  "signMessage",
] as const;

export function sourceRequestsSigning(text: string): boolean {
  const stripped = stripComments(text);
  for (const name of SIGN_METHODS) {
    const dot = new RegExp(`\\.${name}\\s*\\(`);
    const bracket = new RegExp(`\\[\\s*['"]${name}['"]\\s*\\]\\s*\\(`);
    if (dot.test(stripped) || bracket.test(stripped)) {
      return true;
    }
  }
  for (const name of ["secretKey", "privateKey"] as const) {
    const dot = new RegExp(`\\.${name}\\b`);
    const bracket = new RegExp(`\\[\\s*['"]${name}['"]\\s*\\]`);
    if (dot.test(stripped) || bracket.test(stripped)) {
      return true;
    }
  }
  return /\bmnemonic\b/.test(stripped);
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

describe("Phantom adapter", () => {
  it("reports a disconnected wallet when Phantom is absent", async () => {
    const scope = { getProvider: () => undefined };
    expect(detectPhantom(scope).present).toBe(false);
    const session = await connectPhantom(scope);
    expect(session.status).toBe("disconnected");
    expect(session.publicKey).toBeNull();
    expect("network" in session).toBe(false);
  });

  it("connects to a public key and does not read cluster or signing material", async () => {
    const accessed: string[] = [];
    let signCalls = 0;
    const raw = {
      isPhantom: true,
      cluster: "mainnet-beta",
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
  it("does not call signing methods or read key fields, including bracket access", () => {
    expect(sourceRequestsSigning(`provider.signTransaction()`)).toBe(true);
    expect(sourceRequestsSigning(`provider["signTransaction"]()`)).toBe(true);
    expect(sourceRequestsSigning(`provider['signAndSendTransaction']()`)).toBe(true);
    expect(sourceRequestsSigning(`provider["signAllTransactions"]()`)).toBe(true);
    expect(sourceRequestsSigning(`wallet["secretKey"]`)).toBe(true);
    expect(sourceRequestsSigning(`obj['privateKey']`)).toBe(true);
    expect(sourceRequestsSigning(`const phrase = "mnemonic";`)).toBe(true);
    expect(sourceRequestsSigning(`// provider.signTransaction()\nconst ok = 1;`)).toBe(false);

    const root = join(process.cwd(), "src");
    const files = walk(root).filter((file) => file.endsWith(".ts"));
    const hits = files.filter((file) => sourceRequestsSigning(readFileSync(file, "utf8")));
    expect(hits).toEqual([]);
  });

  it("does not treat provider cluster as a wallet field", () => {
    const root = join(process.cwd(), "src");
    const files = walk(root).filter((file) => file.endsWith(".ts"));
    const combined = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(combined).not.toContain("provider.cluster");
    expect(combined).not.toContain("wallet.network");
    const walletDir = join(root, "wallet");
    const walletText = walk(walletDir)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(walletText).not.toMatch(/cluster/i);
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
