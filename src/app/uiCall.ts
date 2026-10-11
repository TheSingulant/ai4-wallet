/** A short reason for a thrown error. No stack, and no second line. */
export function thrownReason(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const line = message.split("\n")[0]?.trim() ?? "";
  if (line === "") {
    return `${prefix}.`;
  }
  const clipped = line.length > 180 ? line.slice(0, 180) : line;
  return `${prefix}: ${clipped}`;
}

/**
 * Attach a rejection handler before the caller returns.
 * A bare `void promise` would drop the error.
 */
export function settleUiAction(
  action: Promise<void>,
  prefix: string,
  onError: (reason: string) => void,
): void {
  void action.catch((error: unknown) => {
    onError(thrownReason(prefix, error));
  });
}
