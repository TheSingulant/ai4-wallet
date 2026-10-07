import { REQUIRED_NETWORK } from "./types";

export function normalizeNetwork(value: string): string {
  return value.trim().toLowerCase();
}

export function isDevnet(value: string): boolean {
  return normalizeNetwork(value) === REQUIRED_NETWORK;
}

/**
 * Visible network label. DevNet is called out by name. Other clusters keep
 * their raw value so a mainnet attempt cannot be hidden.
 */
export function displayNetwork(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "(missing)";
  }
  if (isDevnet(trimmed)) {
    return "DevNet";
  }
  return trimmed;
}

export function devnetGuardReason(value: string): string | null {
  if (isDevnet(value)) {
    return null;
  }
  const shown = value.trim() === "" ? "(missing)" : value.trim();
  return `network is not devnet: ${shown}`;
}
