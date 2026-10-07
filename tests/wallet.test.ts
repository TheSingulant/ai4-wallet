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

  it("registers only the Phantom adapter and one signTransaction method", () => {
    expect(listAdapters().map((adapter) => adapter.id)).toEqual(["phantom"]);
    expect(Object.keys(phantomAdapter).sort()).toEqual([
      "chainFamily",
      "connect",
      "detect",
      "id",
      "signTransaction",
    ]);
    expect("sign" in phantomAdapter).toBe(false);
    expect("signAndSendTransaction" in phantomAdapter).toBe(false);
    expect("signAllTransactions" in phantomAdapter).toBe(false);
    expect("signMessage" in phantomAdapter).toBe(false);
    expect("sendTransaction" in phantomAdapter).toBe(false);
  });

  it("calls signTransaction only when that method is invoked", async () => {
    const accessed: string[] = [];
    let signCalls = 0;
    const raw = {
      isPhantom: true,
      cluster: "mainnet-beta",
      connect: async () => ({ publicKey: { toString: () => "FixturePublicKey" } }),
      secretKey: new Uint8Array(64),
      privateKey: "do-not-read",
      signTransaction: (transaction: { kind: string }) => {
        signCalls += 1;
        return Promise.resolve(transaction);
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
          if (prop !== "signTransaction" && prop !== "isPhantom" && FORBIDDEN_ACCESS.includes(prop)) {
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
    const { Transaction, PublicKey, SystemProgram } = await import("@solana/web3.js");
    const feePayer = new PublicKey(Uint8Array.from({ length: 32 }, () => 4));
    const transaction = new Transaction({
      feePayer,
      recentBlockhash: new PublicKey(Uint8Array.from({ length: 32 }, () => 9)).toBase58(),
    });
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: feePayer,
        toPubkey: new PublicKey("4WDYrTNTit9m7kU5y2LWCfvf35pQo9vbjPTDyiDHEq9e"),
        lamports: 1,
      }),
    );
    const signed = await phantomAdapter.signTransaction(scope, transaction);
    expect(signed).toBe(transaction);
    expect(signCalls).toBe(1);
    expect(accessed.filter((name) => name !== "signTransaction" && name !== "isPhantom" && FORBIDDEN_ACCESS.includes(name))).toEqual([]);
  });
});

const FORBIDDEN_CALLS = [
  "signAndSendTransaction",
  "signAllTransactions",
  "signMessage",
  "sendTransaction",
  "sendRawTransaction",
  "sendAndConfirmTransaction",
];

export function sourceRequestsForbidden(text: string): boolean {
  const stripped = stripComments(text);
  for (const name of FORBIDDEN_CALLS) {
    const dot = new RegExp(`\\.${name}\\s*\\(`);
    const bracket = new RegExp(`\\[\\s*['"]${name}['"]\\s*\\]\\s*\\(`);
    const word = new RegExp(`\\b${name}\\s*\\(`);
    if (dot.test(stripped) || bracket.test(stripped) || word.test(stripped)) {
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

export function countSignTransactionCalls(text: string): number {
  const stripped = stripComments(text);
  const dot = stripped.match(/\.signTransaction\s*\(/g);
  const bracket = stripped.match(/\[\s*['"]signTransaction['"]\s*\]\s*\(/g);
  return (dot?.length ?? 0) + (bracket?.length ?? 0);
}

describe("source boundary", () => {
  it("does not call forbidden signing methods or read key fields, including bracket access", () => {
    expect(sourceRequestsSigning(`provider.signTransaction()`)).toBe(true);
    expect(sourceRequestsSigning(`provider["signTransaction"]()`)).toBe(true);
    expect(sourceRequestsSigning(`provider['signAndSendTransaction']()`)).toBe(true);
    expect(sourceRequestsSigning(`provider["signAllTransactions"]()`)).toBe(true);
    expect(sourceRequestsSigning(`wallet["secretKey"]`)).toBe(true);
    expect(sourceRequestsSigning(`obj['privateKey']`)).toBe(true);
    expect(sourceRequestsSigning(`const phrase = "mnemonic";`)).toBe(true);
    expect(sourceRequestsSigning(`// provider.signTransaction()\nconst ok = 1;`)).toBe(false);
    expect(sourceRequestsForbidden(`connection.sendTransaction(tx)`)).toBe(true);
    expect(sourceRequestsForbidden(`connection.sendRawTransaction(bytes)`)).toBe(true);
    expect(sourceRequestsForbidden(`provider.signAndSendTransaction(tx)`)).toBe(true);
    expect(sourceRequestsForbidden(`provider.signTransaction(tx)`)).toBe(false);

    const root = join(process.cwd(), "src");
    const files = walk(root).filter((file) => file.endsWith(".ts"));
    const forbiddenHits = files.filter((file) => sourceRequestsForbidden(readFileSync(file, "utf8")));
    expect(forbiddenHits).toEqual([]);
    const signCalls = files.flatMap((file) => {
      const count = countSignTransactionCalls(readFileSync(file, "utf8"));
      return count > 0 ? [{ file, count }] : [];
    });
    expect(signCalls).toEqual([{ file: join(root, "wallet", "phantom.ts"), count: 1 }]);
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
