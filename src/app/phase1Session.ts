import { thrownReason } from "./uiCall";
import type { PreviewEvaluation } from "../domain/evaluate";
import type { GenesisRpc } from "../domain/genesisLive";
import {
  beginPreparing,
  emptySigningSession,
  expirePreparedSession,
  failSigningSession,
  invalidateSigningSession,
  markSigningAttempt,
  replaceSigningNote,
  runPrepare,
  signIfGated,
  signingControlsLocked,
  type SigningGeneration,
  type SigningSession,
  type TransferForm,
} from "../domain/signingSession";
import type { WalletSnapshot } from "../domain/types";
import type { BlockhashFreshness, BlockhashSource } from "../solana/devnetConnection";
import type { Transaction } from "@solana/web3.js";

const WAITING_NOTE = "Waiting for Phantom signTransaction.";

export interface Phase1SessionHost {
  getWallet(): WalletSnapshot;
  getForm(): TransferForm;
  getEvaluation(): PreviewEvaluation | null;
  draw(): Promise<void>;
  /** Synchronous read of the injected Phantom public key. */
  readProviderPublicKey(): string | null;
  sign(transaction: Transaction): Promise<Transaction>;
  genesisRpc(): GenesisRpc;
  blockhashSource(): BlockhashSource;
  blockhashProbe(): BlockhashFreshness;
  timeoutMs: number;
  /** Clock for the prepared-transfer countdown. Defaults to Date.now. */
  nowMs?: () => number;
}

export interface Phase1Session {
  readonly session: SigningSession;
  readonly generation: number;
  readonly inFlight: boolean;
  drop(note: string): void;
  prepare(): Promise<void>;
  sign(): Promise<void>;
  /** Fail a ready transfer when its visible window has elapsed. Does not fetch a blockhash. */
  expireIfDue(): boolean;
  /** Record a visible failure when a UI call rejects outside prepare or sign. */
  failVisible(note: string): void;
}

/**
 * UI signing session.
 * One in-flight sign. Prepare does not replace the prepared message while
 * that sign can still reach Phantom. The sign call passes the prepared
 * record and generation it intends to sign.
 */
export function createPhase1Session(host: Phase1SessionHost): Phase1Session {
  const gate: SigningGeneration = { current: 1 };
  const flight = { active: false };
  let preparing = false;
  let session = emptySigningSession();

  function now(): number {
    return host.nowMs?.() ?? Date.now();
  }

  function drop(note: string): void {
    gate.current += 1;
    session = invalidateSigningSession(session, note, gate.current);
  }

  function expireIfDue(): boolean {
    if (flight.active || preparing) {
      return false;
    }
    const nextGeneration = gate.current + 1;
    const next = expirePreparedSession(session, now(), nextGeneration);
    if (next === session) {
      return false;
    }
    gate.current = nextGeneration;
    session = next;
    return true;
  }

  function failVisible(note: string): void {
    if (flight.active || preparing) {
      return;
    }
    gate.current += 1;
    session = failSigningSession(session, note, gate.current);
    void host.draw();
  }

  async function prepare(): Promise<void> {
    if (flight.active || session.readiness === "signing" || session.inFlight) {
      session = replaceSigningNote(session, "A sign attempt is already in progress.");
      await host.draw();
      return;
    }
    if (preparing || signingControlsLocked(session)) {
      session = replaceSigningNote(session, "Prepare is still running.");
      await host.draw();
      return;
    }
    const evaluation = host.getEvaluation();
    if (!evaluation) {
      gate.current += 1;
      session = failSigningSession(session, "No constraint result is available to prepare.", gate.current, null);
      await host.draw();
      return;
    }
    preparing = true;
    gate.current += 1;
    const generation = gate.current;
    session = beginPreparing(session, generation);
    try {
      await host.draw();
      if (gate.current !== generation || flight.active) {
        if (session.readiness === "preparing" && session.note === "Preparing a DevNet transfer.") {
          session = replaceSigningNote(session, "Prepare stopped. The signing session changed.");
        }
        return;
      }
      const next = await runPrepare({
        decision: evaluation.decision,
        constraintResult: evaluation.constraintResult,
        binding: evaluation.approvedBinding,
        bindingSha256: evaluation.approvedBinding?.sha256 ?? null,
        serializedTx: evaluation.serializedTx,
        wallet: host.getWallet(),
        form: host.getForm(),
        genesisRpc: host.genesisRpc(),
        blockhashRpc: host.blockhashSource(),
        timeoutMs: host.timeoutMs,
        nowMs: now(),
        generation,
      });
      if (gate.current !== generation || flight.active) {
        return;
      }
      session = next;
    } catch (error) {
      if (gate.current === generation && !flight.active) {
        session = failSigningSession(session, thrownReason("Prepare failed", error), generation, null);
      }
    } finally {
      preparing = false;
      await drawFailure("Prepare failed");
    }
  }

  async function sign(): Promise<void> {
    if (preparing) {
      session = replaceSigningNote(session, "Prepare is still running.");
      await host.draw();
      return;
    }
    if (flight.active) {
      session = replaceSigningNote(session, "A sign attempt is already in progress.");
      await host.draw();
      return;
    }
    if (expireIfDue()) {
      await host.draw();
      return;
    }
    if (session.readiness !== "ready" || session.prepared === null) {
      session = refuseIdleSign(session);
      await host.draw();
      return;
    }
    const evaluation = host.getEvaluation();
    if (!evaluation || evaluation.decision !== "ALLOW" || evaluation.constraintResult !== "ALLOW") {
      gate.current += 1;
      session = failSigningSession(session, "constraint result is not ALLOW", gate.current, null);
      await host.draw();
      return;
    }
    const attemptGeneration = gate.current;
    const candidate = session.prepared;
    const attemptWallet = host.getWallet();
    flight.active = true;
    session = markSigningAttempt(session);
    let applied = false;
    try {
      await host.draw();
      if (gate.current !== attemptGeneration || session.prepared !== candidate) {
        if (session.inFlight && gate.current === attemptGeneration) {
          session = stopped(session, attemptGeneration, "Sign stopped before Phantom. The signing session changed.");
        }
        applied = true;
        return;
      }
      const outcome = await signIfGated({
        session,
        wallet: attemptWallet,
        form: host.getForm(),
        candidate,
        generation: gate,
        attemptGeneration,
        liveSession: () => session,
        liveForm: () => host.getForm(),
        liveWallet: () => host.getWallet(),
        constraintStillAllow: () => {
          const current = host.getEvaluation();
          return current?.decision === "ALLOW" && current.constraintResult === "ALLOW";
        },
        readProviderPublicKey: () => host.readProviderPublicKey(),
        genesisRpc: host.genesisRpc(),
        blockhashProbe: host.blockhashProbe(),
        timeoutMs: host.timeoutMs,
        sign: (transaction) => host.sign(transaction),
      });
      if (gate.current !== attemptGeneration) {
        if (session.inFlight && session.note === WAITING_NOTE) {
          session = stopped(session, attemptGeneration, "Sign stopped before Phantom. The signing session changed.");
        }
        applied = true;
        return;
      }
      session = outcome.session;
      if (session.inFlight || session.note === WAITING_NOTE) {
        session = stopped(
          session,
          attemptGeneration,
          session.note === WAITING_NOTE
            ? "Sign stopped before Phantom."
            : session.note,
        );
      }
      applied = true;
    } catch (error) {
      session = stopped(session, attemptGeneration, thrownReason("Sign failed", error));
      applied = true;
    } finally {
      flight.active = false;
      if (!applied && session.inFlight && gate.current === attemptGeneration) {
        session = stopped(
          session,
          attemptGeneration,
          session.note === WAITING_NOTE ? "Sign stopped before Phantom." : session.note,
        );
      }
      await drawFailure("Sign failed");
    }
  }

  async function drawFailure(prefix: string): Promise<void> {
    try {
      await host.draw();
    } catch (error) {
      const reason = thrownReason(prefix, error);
      if (session.readiness === "signed" || session.note === reason) {
        return;
      }
      const generation = gate.current;
      session = failSigningSession(session, reason, generation);
    }
  }

  return {
    get session() {
      return session;
    },
    get generation() {
      return gate.current;
    },
    get inFlight() {
      return flight.active;
    },
    drop,
    prepare,
    sign,
    expireIfDue,
    failVisible,
  };
}

function refuseIdleSign(session: SigningSession): SigningSession {
  if (session.readiness === "signed") {
    return session.note.trim() === ""
      ? replaceSigningNote(session, "Signed locally. Not broadcast.")
      : session;
  }
  if (session.readiness === "failed" && session.note.trim() !== "") {
    return session;
  }
  if (
    session.readiness === "unavailable" &&
    session.note.trim() !== "" &&
    session.note !== "Signing readiness is unavailable." &&
    session.note !== WAITING_NOTE
  ) {
    return session;
  }
  return failSigningSession(session, "No prepared transfer is ready to sign.");
}

function stopped(session: SigningSession, generation: number, note: string): SigningSession {
  return failSigningSession(session, note, generation);
}
