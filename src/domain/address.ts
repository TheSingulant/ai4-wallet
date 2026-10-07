const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const INDEX: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i += 1) {
  const char = ALPHABET[i];
  if (char !== undefined) {
    INDEX[char] = i;
  }
}

export function decodeBase58(input: string): Uint8Array {
  if (input.length === 0) {
    throw new Error("empty base58");
  }
  const bytes: number[] = [0];
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const value = char === undefined ? undefined : INDEX[char];
    if (value === undefined) {
      throw new Error("invalid base58");
    }
    for (let j = 0; j < bytes.length; j += 1) {
      const current = bytes[j] ?? 0;
      bytes[j] = current * 58;
    }
    bytes[0] = (bytes[0] ?? 0) + value;
    let carry = 0;
    for (let j = 0; j < bytes.length; j += 1) {
      const current = (bytes[j] ?? 0) + carry;
      bytes[j] = current & 0xff;
      carry = current >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading "1" means a leading zero byte. The significant zero is already in `bytes`.
  for (let i = 0; input[i] === "1" && i < input.length - 1; i += 1) {
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

export function validateSolanaAddress(
  value: string,
): { ok: true; address: string } | { ok: false; reason: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, reason: "destination is required" };
  }
  const address = value.trim();
  if (/[?&#/]/.test(address)) {
    return {
      ok: false,
      reason: "destination contains URI delimiter characters",
    };
  }
  if (address.startsWith("0x")) {
    return { ok: false, reason: "destination is not a Solana address" };
  }
  if (address.length < 32 || address.length > 44) {
    return { ok: false, reason: "destination is not a Solana address" };
  }
  try {
    const decoded = decodeBase58(address);
    if (decoded.length !== 32) {
      return { ok: false, reason: "destination is not a Solana address" };
    }
  } catch {
    return { ok: false, reason: "destination is not a Solana address" };
  }
  return { ok: true, address };
}
