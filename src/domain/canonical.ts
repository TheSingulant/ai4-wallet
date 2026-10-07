import type { ApprovedBinding } from "./types";

/**
 * Python json.dumps(payload, sort_keys=True, separators=(",", ":")).
 * Key order is alphabetical: action, amount_sol, asset, destination, lamports, network.
 */
export function canonicalBindingJson(binding: ApprovedBinding): string {
  if (!Number.isInteger(binding.lamports)) {
    throw new Error("lamports must be an integer");
  }
  const payload = {
    action: binding.action,
    amount_sol: binding.amount_sol,
    asset: binding.asset,
    destination: binding.destination,
    lamports: binding.lamports,
    network: binding.network,
  };
  return JSON.stringify(payload);
}

/**
 * Deterministic preview stub. Not a Solana wire transaction.
 * It cannot be submitted and it is not a signature.
 */
export function canonicalSerializedTx(binding: ApprovedBinding): string {
  return [
    "solana_system_transfer_stub",
    binding.network,
    binding.asset,
    binding.action,
    binding.amount_sol,
    String(binding.lamports),
    binding.destination,
  ].join("|");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(message: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(message));
}

/** SHA-256 over raw bytes. Used for the exact Solana message, not for UTF-8 JSON. */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return hex(new Uint8Array(digest));
}

export function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}
