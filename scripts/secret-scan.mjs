import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const skip = new Set(["node_modules", "dist", ".git", ".vite"]);

export const patterns = [
  { name: "pem-private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "aws-secret-key", re: /aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{20,}/i },
  { name: "github-token", re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "github-pat", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "gitlab-pat", re: /glpat-[A-Za-z0-9\-_]{20,}/ },
  { name: "npm-token", re: /npm_[A-Za-z0-9]{36}/ },
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "stripe-live", re: /sk_live_[A-Za-z0-9]+/ },
  { name: "solana-keypair-array", re: /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/ },
  {
    name: "solana-secret-base58",
    re: /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{87,88}(?![1-9A-HJ-NP-Za-km-z])/,
  },
];

export function scanTree(root) {
  const files = [];
  walk(root, files);
  const findings = [];
  for (const file of files) {
    if (file.endsWith("package-lock.json")) {
      continue;
    }
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) {
      continue;
    }
    for (const pattern of patterns) {
      if (pattern.re.test(text)) {
        findings.push(`${pattern.name}: ${relative(root, file)}`);
      }
    }
  }
  return { files: files.length, findings };
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) {
      continue;
    }
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, out);
    } else if (stat.isFile()) {
      out.push(path);
    }
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const result = scanTree(process.cwd());
  if (result.findings.length > 0) {
    console.error(result.findings.join("\n"));
    process.exit(1);
  }
  console.log(`secret-scan: no findings in ${result.files} files`);
}
