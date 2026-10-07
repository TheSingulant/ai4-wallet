import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEVNET_GENESIS_HASH } from "../src/domain/networkAuthority";
import { patterns } from "../scripts/secret-scan.mjs";

describe("phase 0 project locks", () => {
  it("requires Node 22.12.0 or newer and pins CI to a compatible Node", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toBe(">=22.12.0");
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain('node-version: "22.12.0"');
    expect(ci).not.toMatch(/uses:\s*actions\/checkout@v\d+/);
    expect(ci).not.toMatch(/uses:\s*actions\/setup-node@v\d+/);
    expect(ci).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(ci).toMatch(/actions\/setup-node@[0-9a-f]{40}/);
  });

  it("documents the Phase 1 network and exact-message invariants", () => {
    const architecture = readFileSync("docs/architecture.md", "utf8");
    const threat = readFileSync("docs/threat-model.md", "utf8");
    expect(architecture).toContain(DEVNET_GENESIS_HASH);
    expect(architecture).toContain("getGenesisHash()");
    expect(architecture).toContain("not sufficient to authorize a future signature");
    expect(architecture).toContain("signTransaction");
    expect(architecture).toContain("blockhash");
    expect(architecture).toContain("fee payer");
    expect(architecture).toContain("program IDs");
    expect(architecture).toContain("account metas");
    expect(architecture).toContain("Any byte difference drops signing readiness");
    expect(architecture).not.toMatch(/without replacing the binding/i);
    expect(architecture).toContain("Phase 1 cannot add a sign path on this binding alone");
    expect(threat).toContain(DEVNET_GENESIS_HASH);
    expect(`${architecture}\n${threat}`).not.toContain("\u2014");
  });

  it("flags high-confidence secrets and ignores the DevNet genesis hash", () => {
    const names = (text: string) =>
      patterns.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.name);
    expect(names("5".repeat(88))).toContain("solana-secret-base58");
    expect(names(DEVNET_GENESIS_HASH)).not.toContain("solana-secret-base58");
    expect(names(`npm_${"a".repeat(36)}`)).toContain("npm-token");
    expect(names(`ghp_${"a".repeat(20)}`)).toContain("github-token");
    expect(names(`glpat-${"a".repeat(20)}`)).toContain("gitlab-pat");
    expect(names(`AKIA${"IOSFODNN7EXAMPLE"}`)).toContain("aws-access-key");
  });
});
