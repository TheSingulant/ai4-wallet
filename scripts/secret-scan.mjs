import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const skip = new Set(["node_modules", "dist", ".git", ".vite"]);
const patterns = [
  { name: "pem-private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "github-token", re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "github-pat", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "stripe-live", re: /sk_live_[A-Za-z0-9]+/ },
  { name: "solana-keypair-array", re: /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/ },
];

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
  for (const pattern of patterns) {
    if (pattern.re.test(text)) {
      findings.push(`${pattern.name}: ${relative(root, file)}`);
    }
  }
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exit(1);
}

console.log(`secret-scan: no findings in ${files.length} files`);

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
