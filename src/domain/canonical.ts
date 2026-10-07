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

export async function sha256Hex(message: string): Promise<string> {
  const bytes = new TextEncoder().encode(message);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
