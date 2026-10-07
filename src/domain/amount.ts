import { PHASE0_MAX_SOL } from "./types";

const LAMPORTS_PER_SOL = 1_000_000_000n;
const MAX_LAMPORTS = (1n << 64n) - 1n;
const PHASE0_MAX_LAMPORTS = 10_000_000n;

export interface ParsedAmount {
  amount_sol: string;
  lamports: number;
}

export function parseSolAmount(
  raw: string,
): { ok: true; value: ParsedAmount } | { ok: false; reason: string } {
  if (typeof raw !== "string") {
    return { ok: false, reason: "amount is not a decimal SOL amount" };
  }
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return { ok: false, reason: "amount is not a decimal SOL amount" };
  }
  const [whole, frac = ""] = text.split(".");
  if (whole === undefined) {
    return { ok: false, reason: "amount is not a decimal SOL amount" };
  }
  if (frac.length > 9) {
    return { ok: false, reason: "amount exceeds SOL lamport precision" };
  }
  const lamports =
    BigInt(whole) * LAMPORTS_PER_SOL + BigInt((frac + "000000000").slice(0, 9));
  if (lamports <= 0n) {
    return { ok: false, reason: "amount must be greater than 0" };
  }
  if (lamports > MAX_LAMPORTS) {
    return { ok: false, reason: "amount exceeds the u64 lamport range" };
  }
  if (lamports > PHASE0_MAX_LAMPORTS) {
    return {
      ok: false,
      reason: `amount exceeds the Phase 0 DevNet cap of ${PHASE0_MAX_SOL} SOL`,
    };
  }
  const asNumber = Number(lamports);
  if (!Number.isSafeInteger(asNumber)) {
    return { ok: false, reason: "amount exceeds the integer range this preview can bind" };
  }
  return {
    ok: true,
    value: { amount_sol: formatLamports(lamports), lamports: asNumber },
  };
}

export function formatLamports(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = lamports % LAMPORTS_PER_SOL;
  if (frac === 0n) {
    return whole.toString();
  }
  const fracText = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracText}`;
}
