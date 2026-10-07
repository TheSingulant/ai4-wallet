import { createHash } from "node:crypto";
import { Message, PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { sha256Bytes } from "../src/domain/canonical";
import {
  buildLegacySolTransfer,
  exactTransaction,
  preSignRecheck,
  readSystemTransferMessage,
  SYSTEM_PROGRAM_ID,
} from "../src/domain/nativeTransfer";
import { runPrepare } from "../src/domain/signingSession";
import { ALT_DESTINATION, KNOWN_BINDING_SHA256 } from "../src/fixtures/preview";
import {
  allowEvaluation,
  BLOCKHASH_A,
  BLOCKHASH_B,
  blockhashRpc,
  FEE_PAYER,
  formFrom,
  genesisRpc,
  PHANTOM_WALLET,
  preparedAllow,
  pubkey,
} from "./phase1/helpers";

describe("exact message binding", () => {
  it("keeps the six-field audit digest and does not use it as the message hash", async () => {
    const { session } = await preparedAllow();
    const prepared = session.prepared;
    expect(prepared).not.toBeNull();
    expect(prepared?.bindingSha256).toBe(KNOWN_BINDING_SHA256);
    expect(prepared?.messageSha256).not.toBe(KNOWN_BINDING_SHA256);
    expect(prepared?.genesisHash).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    const oracle = createHash("sha256").update(prepared!.messageBytes).digest("hex");
    expect(oracle).toBe(prepared?.messageSha256);
    expect(await sha256Bytes(prepared!.messageBytes)).toBe(prepared?.messageSha256);
  });

  it("freezes the prepared record and copies message bytes on read", async () => {
    const { session } = await preparedAllow();
    const prepared = session.prepared!;
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.binding)).toBe(true);
    expect(() => {
      (prepared as { blockhash: string }).blockhash = BLOCKHASH_B;
    }).toThrow(TypeError);
    expect(() => {
      (prepared as { messageSha256: string }).messageSha256 = "00";
    }).toThrow(TypeError);
    const exposed = prepared.messageBytes;
    const first = exposed[0] ?? 0;
    exposed[0] = (first + 1) & 0xff;
    expect(prepared.messageBytes[0]).toBe(first);
    expect(prepared.blockhash).toBe(BLOCKHASH_A);
    expect(prepared.preparedAtMs).toBe(1_700_000_000_000);
  });

  it("covers fee payer, blockhash, system transfer, recipient, lamports, program id, metas, flags, and order", async () => {
    const { session } = await preparedAllow();
    const transaction = exactTransaction(session.prepared!);
    expect(transaction).toBeDefined();
    const shape = readSystemTransferMessage(transaction!);
    expect(shape.ok).toBe(true);
    if (!shape.ok) {
      return;
    }
    expect(shape.shape.feePayer).toBe(FEE_PAYER);
    expect(shape.shape.recipient).toBe(session.prepared?.binding.destination);
    expect(shape.shape.lamports).toBe(1_000_000);
    expect(shape.shape.recentBlockhash).toBe(BLOCKHASH_A);
    expect(shape.shape.programId).toBe(SYSTEM_PROGRAM_ID);
    expect(shape.shape.programId).toBe("11111111111111111111111111111111");
    expect(shape.shape.numRequiredSignatures).toBe(1);
    expect(shape.shape.numReadonlySignedAccounts).toBe(0);
    expect(shape.shape.numReadonlyUnsignedAccounts).toBe(1);
    expect(shape.shape.accountKeys).toEqual([
      FEE_PAYER,
      session.prepared?.binding.destination,
      SYSTEM_PROGRAM_ID,
    ]);
    expect(shape.shape.instructionAccounts).toEqual([
      FEE_PAYER,
      session.prepared?.binding.destination,
    ]);
    expect(transaction?.instructions).toHaveLength(1);
  });

  it("changes the message hash when a covered field changes", async () => {
    const feePayer = new PublicKey(FEE_PAYER);
    const destination = new PublicKey(sessionDestination());
    const base = buildLegacySolTransfer({
      feePayer,
      destination,
      lamports: 1_000_000,
      blockhash: BLOCKHASH_A,
      lastValidBlockHeight: 100,
    });
    const baseHash = await sha256Bytes(base.serializeMessage());
    const variants = [
      buildLegacySolTransfer({
        feePayer,
        destination,
        lamports: 1_000_001,
        blockhash: BLOCKHASH_A,
        lastValidBlockHeight: 100,
      }),
      buildLegacySolTransfer({
        feePayer,
        destination: new PublicKey(ALT_DESTINATION),
        lamports: 1_000_000,
        blockhash: BLOCKHASH_A,
        lastValidBlockHeight: 100,
      }),
      buildLegacySolTransfer({
        feePayer: new PublicKey(pubkey(5)),
        destination,
        lamports: 1_000_000,
        blockhash: BLOCKHASH_A,
        lastValidBlockHeight: 100,
      }),
      buildLegacySolTransfer({
        feePayer,
        destination,
        lamports: 1_000_000,
        blockhash: BLOCKHASH_B,
        lastValidBlockHeight: 100,
      }),
    ];
    for (const variant of variants) {
      expect(await sha256Bytes(variant.serializeMessage())).not.toBe(baseHash);
    }

    const extra = buildLegacySolTransfer({
      feePayer,
      destination,
      lamports: 1_000_000,
      blockhash: BLOCKHASH_A,
      lastValidBlockHeight: 100,
    });
    extra.add(
      SystemProgram.transfer({
        fromPubkey: feePayer,
        toPubkey: destination,
        lamports: 1,
      }),
    );
    expect(readSystemTransferMessage(extra).ok).toBe(false);
    expect(await sha256Bytes(extra.serializeMessage())).not.toBe(baseHash);

    const message = base.compileMessage();
    const flagged = new Message({
      header: { ...message.header, numReadonlyUnsignedAccounts: 0 },
      accountKeys: message.accountKeys,
      recentBlockhash: message.recentBlockhash,
      instructions: message.instructions,
    });
    expect(await sha256Bytes(flagged.serialize())).not.toBe(baseHash);
  });

  it("fail closed when the audit digest does not match the binding", async () => {
    const evaluation = await allowEvaluation();
    const blockhash = blockhashRpc();
    const session = await runPrepare({
      decision: "ALLOW",
      constraintResult: "ALLOW",
      binding: evaluation.approvedBinding,
      bindingSha256: "00".repeat(32),
      serializedTx: evaluation.serializedTx,
      wallet: PHANTOM_WALLET,
      form: formFrom(evaluation),
      genesisRpc: genesisRpc().rpc,
      blockhashRpc: blockhash.rpc,
    });
    expect(session.readiness).toBe("unavailable");
    expect(session.prepared).toBeNull();
    expect(blockhash.calls).toEqual([]);
  });

  it("clears readiness when the prepared message bytes change before signing", async () => {
    const { session } = await preparedAllow();
    const prepared = session.prepared!;
    const transaction = exactTransaction(prepared);
    expect(transaction).toBeDefined();
    transaction!.recentBlockhash = BLOCKHASH_B;
    const recheck = await preSignRecheck(prepared);
    expect(recheck.ok).toBe(false);
    if (!recheck.ok) {
      expect(recheck.reason).toMatch(/mismatch/);
    }
    expect(prepared.blockhash).toBe(BLOCKHASH_A);
    expect(prepared.messageSha256).not.toBe(await sha256Bytes(transaction!.serializeMessage()));
  });
});

function sessionDestination(): string {
  return "4WDYrTNTit9m7kU5y2LWCfvf35pQo9vbjPTDyiDHEq9e";
}
