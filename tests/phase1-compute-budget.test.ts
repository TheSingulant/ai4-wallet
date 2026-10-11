import {
  ComputeBudgetProgram,
  Message,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { decodeBase58 } from "../src/domain/address";
import { bytesEqual } from "../src/domain/canonical";
import {
  BASE_SIGNATURE_FEE_LAMPORTS,
  buildLegacySolTransfer,
  COMPUTE_BUDGET_PROGRAM_ID,
  computeUnitLimitData,
  computeUnitPriceData,
  expectedNetworkFeeLamports,
  FIXED_COMPUTE_UNIT_LIMIT,
  FIXED_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  LAMPORTS_PER_SOL,
  MAX_SOLANA_TRANSACTION_BYTES,
  prioritizationFeeLamports,
  readSystemTransferMessage,
  SYSTEM_PROGRAM_ID,
} from "../src/domain/nativeTransfer";
import { signIfGated } from "../src/domain/signingSession";
import {
  BLOCKHASH_A,
  BLOCKHASH_B,
  fakeSign,
  FEE_PAYER,
  freshProbe,
  genesisRpc,
  PHANTOM_WALLET,
  preparedAllow,
  stableGuards,
  TEST_PAYER,
} from "./phase1/helpers";

const DESTINATION = "4WDYrTNTit9m7kU5y2LWCfvf35pQo9vbjPTDyiDHEq9e";

describe("fixed compute budget transfer", () => {
  it("builds limit, price, then transfer with exact bytes for a normal transfer and a self-transfer", () => {
    const feePayer = new PublicKey(FEE_PAYER);
    const destination = new PublicKey(DESTINATION);
    const normal = buildLegacySolTransfer({
      feePayer,
      destination,
      lamports: 1_000_000,
      blockhash: BLOCKHASH_A,
      lastValidBlockHeight: 100,
    });
    const self = buildLegacySolTransfer({
      feePayer,
      destination: feePayer,
      lamports: 1_000,
      blockhash: BLOCKHASH_A,
      lastValidBlockHeight: 100,
    });

    expect(normal.serializeMessage().byteLength).toBeLessThan(MAX_SOLANA_TRANSACTION_BYTES);
    expect(self.serializeMessage().byteLength).toBeLessThan(MAX_SOLANA_TRANSACTION_BYTES);
    expect(prioritizationFeeLamports()).toBe(1);
    expect(expectedNetworkFeeLamports()).toBe(BASE_SIGNATURE_FEE_LAMPORTS + 1);
    expect(expectedNetworkFeeLamports() / LAMPORTS_PER_SOL).toBe(0.000005001);

    expectInstructionShape(normal, {
      accountKeys: [FEE_PAYER, DESTINATION, SYSTEM_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID],
      transferAccounts: [0, 1],
      computeIndex: 3,
      systemIndex: 2,
      lamports: 1_000_000,
    });
    expectInstructionShape(self, {
      accountKeys: [FEE_PAYER, SYSTEM_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID],
      transferAccounts: [0, 0],
      computeIndex: 2,
      systemIndex: 1,
      lamports: 1_000,
    });
  });

  it("refuses every deviation from the fixed instruction set", () => {
    const feePayer = new PublicKey(FEE_PAYER);
    const destination = new PublicKey(DESTINATION);
    const transfer = SystemProgram.transfer({
      fromPubkey: feePayer,
      toPubkey: destination,
      lamports: 1_000_000,
    });
    const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: FIXED_COMPUTE_UNIT_LIMIT });
    const price = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: FIXED_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    });
    const cases: Array<[string, Transaction]> = [
      ["missing both compute budget instructions", txWith([transfer])],
      ["missing the price instruction", txWith([limit, transfer])],
      ["missing the limit instruction", txWith([price, transfer])],
      ["missing the system transfer", txWith([limit, price])],
      [
        "an extra instruction",
        txWith([
          limit,
          price,
          transfer,
          SystemProgram.transfer({ fromPubkey: feePayer, toPubkey: destination, lamports: 1 }),
        ]),
      ],
      ["price before limit", txWith([price, limit, transfer])],
      ["transfer before the compute budget", txWith([transfer, limit, price])],
      ["transfer between the compute budget instructions", txWith([limit, transfer, price])],
      [
        "a changed compute unit limit",
        txWith([ComputeBudgetProgram.setComputeUnitLimit({ units: 999 }), price, transfer]),
      ],
      [
        "a zero compute unit price",
        txWith([limit, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }), transfer]),
      ],
      [
        "a Phantom-sized compute unit price",
        txWith([
          limit,
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 375_000 }),
          transfer,
        ]),
      ],
      ["a limit instruction with an account", txWith([withAccount(limit, feePayer), price, transfer])],
      ["a price instruction with an account", txWith([limit, withAccount(price, destination), transfer])],
      [
        "a heap frame in place of the limit",
        txWith([ComputeBudgetProgram.requestHeapFrame({ bytes: 32 * 1024 }), price, transfer]),
      ],
      [
        "a different compute budget discriminator in place of the price",
        txWith([
          limit,
          new TransactionInstruction({
            keys: [],
            programId: ComputeBudgetProgram.programId,
            data: Buffer.from([4, 0, 0, 0, 1]),
          }),
          transfer,
        ]),
      ],
      [
        "a third instruction that is not the system transfer",
        txWith([limit, price, ComputeBudgetProgram.requestHeapFrame({ bytes: 32 * 1024 })]),
      ],
      ["a transfer with one account", txWith([limit, price, transferWithAccounts(transfer, 1)])],
      ["a transfer with three accounts", txWith([limit, price, transferWithAccounts(transfer, 3, feePayer)])],
      [
        "transfer data that is not a system transfer",
        txWith([
          limit,
          price,
          new TransactionInstruction({
            keys: transfer.keys,
            programId: SystemProgram.programId,
            data: Buffer.alloc(12, 0),
          }),
        ]),
      ],
    ];

    const reasons = new Map<string, string>();
    for (const [label, transaction] of cases) {
      const result = readSystemTransferMessage(transaction);
      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(result.reason.length, label).toBeGreaterThan(0);
        reasons.set(label, result.reason);
      }
    }
    expect(reasons.get("missing both compute budget instructions")).toMatch(/exactly the compute budget/);
    expect(reasons.get("missing the price instruction")).toMatch(/exactly the compute budget/);
    expect(reasons.get("missing the limit instruction")).toMatch(/exactly the compute budget/);
    expect(reasons.get("missing the system transfer")).toMatch(/exactly the compute budget/);
    expect(reasons.get("an extra instruction")).toMatch(/exactly the compute budget/);
    expect(reasons.get("price before limit")).toMatch(/not setComputeUnitLimit/);
    expect(reasons.get("transfer before the compute budget")).toMatch(/not the compute budget program/);
    expect(reasons.get("transfer between the compute budget instructions")).toMatch(
      /second instruction is not the compute budget program/,
    );
    expect(reasons.get("a changed compute unit limit")).toMatch(/limit data is not the fixed/);
    expect(reasons.get("a zero compute unit price")).toMatch(/price data is not the fixed/);
    expect(reasons.get("a Phantom-sized compute unit price")).toMatch(/price data is not the fixed/);
    expect(reasons.get("a limit instruction with an account")).toMatch(/limit instruction has unexpected accounts/);
    expect(reasons.get("a price instruction with an account")).toMatch(/price instruction has unexpected accounts/);
    expect(reasons.get("a heap frame in place of the limit")).toMatch(/not setComputeUnitLimit/);
    expect(reasons.get("a different compute budget discriminator in place of the price")).toMatch(
      /not setComputeUnitPrice/,
    );
    expect(reasons.get("a third instruction that is not the system transfer")).toMatch(/not the system program/);
    expect(reasons.get("a transfer with one account")).toMatch(/source and recipient/);
    expect(reasons.get("a transfer with three accounts")).toMatch(/source and recipient/);
    expect(reasons.get("transfer data that is not a system transfer")).toMatch(/not a system transfer/);
  });

  it("refuses a compiled message that cannot be read or that breaks header, order, or indexes", () => {
    const feePayer = new PublicKey(FEE_PAYER);
    const destination = new PublicKey(DESTINATION);
    const base = buildLegacySolTransfer({
      feePayer,
      destination,
      lamports: 1_000_000,
      blockhash: BLOCKHASH_A,
      lastValidBlockHeight: 100,
    });
    const compiled = base.compileMessage();

    const broken = buildLegacySolTransfer({
      feePayer,
      destination,
      lamports: 1_000_000,
      blockhash: BLOCKHASH_A,
      lastValidBlockHeight: 100,
    });
    broken.compileMessage = () => {
      throw new Error("unreadable");
    };
    expect(reason(broken)).toMatch(/could not be compiled/);

    const missing = buildLegacySolTransfer({
      feePayer,
      destination,
      lamports: 1_000_000,
      blockhash: BLOCKHASH_A,
      lastValidBlockHeight: 100,
    });
    missing.compileMessage = () =>
      ({
        header: compiled.header,
        accountKeys: compiled.accountKeys,
        recentBlockhash: compiled.recentBlockhash,
        instructions: [compiled.instructions[0], compiled.instructions[1], undefined],
      }) as unknown as Message;
    expect(reason(missing)).toMatch(/missing an instruction/);

    const incomplete = withMessage(base, compiled, {
      instructions: [
        compiled.instructions[0]!,
        compiled.instructions[1]!,
        { ...compiled.instructions[2]!, accounts: [0, undefined as unknown as number] },
      ],
    });
    expect(reason(incomplete)).toMatch(/incomplete/);

    const absent = withMessage(base, compiled, {
      instructions: [
        compiled.instructions[0]!,
        compiled.instructions[1]!,
        { ...compiled.instructions[2]!, accounts: [0, 9] },
      ],
    });
    expect(reason(absent)).toMatch(/accounts are missing/);

    expect(reason(withHeader(base, compiled, { numRequiredSignatures: 2 }))).toMatch(
      /exactly one signature/,
    );
    expect(reason(withHeader(base, compiled, { numReadonlySignedAccounts: 1 }))).toMatch(
      /readonly signed/,
    );
    expect(reason(withHeader(base, compiled, { numReadonlyUnsignedAccounts: 1 }))).toMatch(
      /readonly unsigned/,
    );

    const swapped = new Message({
      header: compiled.header,
      accountKeys: [
        compiled.accountKeys[0]!,
        compiled.accountKeys[1]!,
        compiled.accountKeys[3]!,
        compiled.accountKeys[2]!,
      ],
      recentBlockhash: compiled.recentBlockhash,
      instructions: [
        { programIdIndex: 2, accounts: [], data: compiled.instructions[0]!.data },
        { programIdIndex: 2, accounts: [], data: compiled.instructions[1]!.data },
        { programIdIndex: 3, accounts: [0, 1], data: compiled.instructions[2]!.data },
      ],
    });
    expect(reason(withFrozenMessage(base, swapped))).toMatch(/account key ordering/);

    const self = buildLegacySolTransfer({
      feePayer,
      destination: feePayer,
      lamports: 1_000,
      blockhash: BLOCKHASH_A,
      lastValidBlockHeight: 100,
    });
    const selfCompiled = self.compileMessage();
    const selfSwapped = new Message({
      header: selfCompiled.header,
      accountKeys: [selfCompiled.accountKeys[0]!, selfCompiled.accountKeys[2]!, selfCompiled.accountKeys[1]!],
      recentBlockhash: selfCompiled.recentBlockhash,
      instructions: [
        { programIdIndex: 1, accounts: [], data: selfCompiled.instructions[0]!.data },
        { programIdIndex: 1, accounts: [], data: selfCompiled.instructions[1]!.data },
        { programIdIndex: 2, accounts: [0, 0], data: selfCompiled.instructions[2]!.data },
      ],
    });
    expect(reason(withFrozenMessage(self, selfSwapped))).toMatch(/self-transfer account key ordering/);

    const badIndexes = withMessage(base, compiled, {
      instructions: [
        compiled.instructions[0]!,
        compiled.instructions[1]!,
        { ...compiled.instructions[2]!, accounts: [1, 0] },
      ],
    });
    expect(reason(badIndexes)).toMatch(/fee payer|source then recipient|account key ordering/);

    const blockhash = withFrozenMessage(base, compiled);
    blockhash.recentBlockhash = BLOCKHASH_B;
    expect(reason(blockhash)).toMatch(/blockhash does not match/);

    const shortHash = "tVojvhToWjQ8Xvo4UPx2Xz9eRy7auyYMmZBjc2XfN";
    const short = withFrozenMessage(
      base,
      new Message({
        header: compiled.header,
        accountKeys: compiled.accountKeys,
        recentBlockhash: shortHash,
        instructions: compiled.instructions,
      }),
    );
    short.recentBlockhash = shortHash;
    expect(reason(short)).toMatch(/32-byte base58/);

    const otherPayer = new PublicKey(Uint8Array.from({ length: 32 }, () => 8));
    const movedPayer = withFrozenMessage(base, compiled);
    movedPayer.feePayer = otherPayer;
    expect(reason(movedPayer)).toMatch(/fee payer/);
  });

  it("fails closed when Phantom rewrites the compute budget and stores no signature", async () => {
    const { session, form } = await preparedAllow();
    const prepared = session.prepared!;
    const outcome = await signIfGated({
      ...stableGuards(session, form),
      session,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: freshProbe(),
      sign: async (transaction) => {
        transaction.instructions[1] = ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 375_000,
        });
        return fakeSign(transaction);
      },
    });
    expect(outcome.phantomCalled).toBe(true);
    expect(outcome.session.readiness).toBe("failed");
    expect(outcome.session.signed).toBeNull();
    expect(outcome.session.note).toBe("signed message does not match the prepared message");
    expect(outcome.session.note).not.toMatch(/Signed locally/);
    expect(prepared.blockhash).toBe(BLOCKHASH_A);

    const injected = await signIfGated({
      ...stableGuards(session, form),
      session,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: freshProbe(),
      sign: async (transaction) => {
        const payer = transaction.feePayer;
        const recipient = new PublicKey(prepared.binding.destination);
        if (!payer) {
          throw new Error("missing fee payer");
        }
        const replacement = new Transaction({
          feePayer: payer,
          recentBlockhash: transaction.recentBlockhash,
        });
        replacement.lastValidBlockHeight = transaction.lastValidBlockHeight;
        replacement.add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 375_000 }),
          SystemProgram.transfer({
            fromPubkey: payer,
            toPubkey: recipient,
            lamports: prepared.binding.lamports,
          }),
        );
        return fakeSign(replacement);
      },
    });
    expect(injected.phantomCalled).toBe(true);
    expect(injected.session.readiness).toBe("failed");
    expect(injected.session.signed).toBeNull();
    expect(injected.session.note).toBe("signed message does not match the prepared message");
  });

  it("reaches Signed locally when Phantom returns the prepared message unchanged", async () => {
    const { session, form } = await preparedAllow();
    const prepared = session.prepared!;
    const outcome = await signIfGated({
      ...stableGuards(session, form),
      session,
      wallet: PHANTOM_WALLET,
      form,
      genesisRpc: genesisRpc().rpc,
      blockhashProbe: freshProbe(),
      sign: async (transaction) => {
        expect(bytesEqual(transaction.serializeMessage(), prepared.messageBytes)).toBe(true);
        expect(readSystemTransferMessage(transaction).ok).toBe(true);
        return fakeSign(transaction);
      },
    });
    expect(outcome.phantomCalled).toBe(true);
    expect(outcome.session.readiness).toBe("signed");
    expect(outcome.session.note).toBe("Signed locally. Not broadcast.");
    expect(outcome.session.signed?.broadcast).toBe(false);
    expect(outcome.session.signed?.signature.byteLength).toBe(64);
    expect(bytesEqual(outcome.session.prepared?.messageBytes ?? new Uint8Array(), prepared.messageBytes)).toBe(
      true,
    );
  });
});

function expectInstructionShape(
  transaction: Transaction,
  expected: {
    accountKeys: string[];
    transferAccounts: number[];
    computeIndex: number;
    systemIndex: number;
    lamports: number;
  },
): void {
  const shape = readSystemTransferMessage(transaction);
  expect(shape.ok).toBe(true);
  if (!shape.ok) {
    return;
  }
  expect(shape.shape.numRequiredSignatures).toBe(1);
  expect(shape.shape.numReadonlySignedAccounts).toBe(0);
  expect(shape.shape.numReadonlyUnsignedAccounts).toBe(2);
  expect(shape.shape.accountKeys).toEqual(expected.accountKeys);
  expect(shape.shape.lamports).toBe(expected.lamports);
  expect(transaction.instructions).toHaveLength(3);
  const [limit, price, transfer] = transaction.instructions;
  expect(Buffer.from(limit!.data)).toEqual(Buffer.from(computeUnitLimitData()));
  expect(Buffer.from(price!.data)).toEqual(Buffer.from(computeUnitPriceData()));
  expect(limit!.programId.toBase58()).toBe(COMPUTE_BUDGET_PROGRAM_ID);
  expect(price!.programId.toBase58()).toBe(COMPUTE_BUDGET_PROGRAM_ID);
  expect(limit!.keys).toEqual([]);
  expect(price!.keys).toEqual([]);
  expect(transfer!.programId.toBase58()).toBe(SYSTEM_PROGRAM_ID);
  const message = transaction.compileMessage();
  expect(message.instructions[0]?.programIdIndex).toBe(expected.computeIndex);
  expect(message.instructions[1]?.programIdIndex).toBe(expected.computeIndex);
  expect(message.instructions[2]?.programIdIndex).toBe(expected.systemIndex);
  expect(message.instructions[2]?.accounts).toEqual(expected.transferAccounts);
  expect([...decodeBase58(message.instructions[0]!.data)]).toEqual([...computeUnitLimitData()]);
  expect([...decodeBase58(message.instructions[1]!.data)]).toEqual([...computeUnitPriceData()]);
}

function txWith(instructions: TransactionInstruction[]): Transaction {
  const transaction = new Transaction({
    feePayer: TEST_PAYER.publicKey,
    recentBlockhash: BLOCKHASH_A,
  });
  transaction.lastValidBlockHeight = 100;
  transaction.add(...instructions);
  return transaction;
}

function withAccount(instruction: TransactionInstruction, pubkey: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: instruction.programId,
    data: instruction.data,
    keys: [...instruction.keys, { pubkey, isSigner: false, isWritable: false }],
  });
}

function transferWithAccounts(
  instruction: TransactionInstruction,
  count: number,
  extra?: PublicKey,
): TransactionInstruction {
  const keys = instruction.keys.slice(0, count);
  while (keys.length < count) {
    keys.push({ pubkey: extra ?? instruction.keys[0]!.pubkey, isSigner: false, isWritable: true });
  }
  return new TransactionInstruction({
    programId: instruction.programId,
    data: instruction.data,
    keys,
  });
}

function reason(transaction: Transaction): string {
  const result = readSystemTransferMessage(transaction);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.reason;
}

function withHeader(
  transaction: Transaction,
  compiled: Message,
  header: Partial<Message["header"]>,
): Transaction {
  return withFrozenMessage(
    transaction,
    new Message({
      header: { ...compiled.header, ...header },
      accountKeys: compiled.accountKeys,
      recentBlockhash: compiled.recentBlockhash,
      instructions: compiled.instructions,
    }),
  );
}

function withMessage(
  transaction: Transaction,
  compiled: Message,
  patch: { instructions: Message["instructions"] },
): Transaction {
  return withFrozenMessage(
    transaction,
    new Message({
      header: compiled.header,
      accountKeys: compiled.accountKeys,
      recentBlockhash: compiled.recentBlockhash,
      instructions: patch.instructions,
    }),
  );
}

function withFrozenMessage(transaction: Transaction, message: Message): Transaction {
  const copy = buildLegacySolTransfer({
    feePayer: transaction.feePayer ?? TEST_PAYER.publicKey,
    destination: new PublicKey(DESTINATION),
    lamports: 1_000_000,
    blockhash: transaction.recentBlockhash ?? BLOCKHASH_A,
    lastValidBlockHeight: transaction.lastValidBlockHeight ?? 100,
  });
  copy.compileMessage = () => message;
  return copy;
}
