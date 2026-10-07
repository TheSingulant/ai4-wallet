import type { PreviewEvaluation } from "../domain/evaluate";
import type { GenesisRpc } from "../domain/genesisLive";
import {
  beginPreparing,
  emptySigningSession,
  invalidateSigningSession,
  markSigningAttempt,
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
}

export interface Phase1Session {
  readonly session: SigningSession;
  readonly generation: number;
  readonly inFlight: boolean;
  drop(note: string): void;
  prepare(): Promise<void>;
  sign(): Promise<void>;
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

  function drop(note: string): void {
    gate.current += 1;
    session = invalidateSigningSession(session, note, gate.current);
  }

  async function prepare(): Promise<void> {
    if (flight.active || preparing || signingControlsLocked(session)) {
      return;
    }
    const evaluation = host.getEvaluation();
    if (!evaluation) {
      return;
    }
    preparing = true;
    gate.current += 1;
    const generation = gate.current;
    session = beginPreparing(session, generation);
    try {
      await host.draw();
      if (gate.current !== generation || flight.active) {
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
        generation,
      });
      if (gate.current !== generation || flight.active) {
        return;
      }
      session = next;
    } finally {
      preparing = false;
      await host.draw();
    }
  }

  async function sign(): Promise<void> {
    if (flight.active || preparing) {
      return;
    }
    if (session.readiness !== "ready" || session.prepared === null) {
      return;
    }
    const evaluation = host.getEvaluation();
    if (!evaluation || evaluation.decision !== "ALLOW" || evaluation.constraintResult !== "ALLOW") {
      drop("constraint result is not ALLOW");
      await host.draw();
      return;
    }
    const attemptGeneration = gate.current;
    const candidate = session.prepared;
    const attemptWallet = host.getWallet();
    flight.active = true;
    session = markSigningAttempt(session);
    try {
      await host.draw();
      if (gate.current !== attemptGeneration || session.prepared !== candidate) {
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
        return;
      }
      session = outcome.session;
    } finally {
      flight.active = false;
      if (session.inFlight && gate.current === attemptGeneration) {
        session = invalidateSigningSession(session, session.note, attemptGeneration);
      }
      await host.draw();
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
  };
}
