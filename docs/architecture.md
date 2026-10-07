# Architecture

## Recommendation

Phase 0 lives in the public repository TheSingulant/ai4-wallet. The browser UI stays separate from TheSingulant/ai4-constrain. This repository does not modify ai4-constrain, does not vendor it, and does not put a frontend inside it.

## What this is

A non-custodial web preview. It shows a DevNet transaction intent, a fixture constraint result, signing readiness, and an approved binding before a person would sign in their own wallet. AI⁴ does not hold keys and does not move funds.

Phase 0 is fixture-driven. It does not call the Python constrain engine, a production verifier, or a chain RPC.

## Flow

```
fixture intent
  -> app DevNet preview network guard
  -> deterministic checks (asset, action, amount, destination, custody flags)
  -> constraint result ALLOW | REVISE | REFUSE
  -> signing readiness unavailable | not_ready
  -> on ALLOW only: frozen ApprovedBinding audit digest
  -> recheck current form and current wallet session
  -> Phantom detect / connect identity stub
  -> Verify status from the preview stub
```

Phase 0 keeps `signingHandoff` empty. Its evaluator never reaches ready, and it does not request a signature or send a transaction. Phase 1 readiness is a separate field. It can reach ready only after the exact message is bound. Phase 1 still does not send a transaction.

## Signing boundary

The wallet adapter interface exposes `detect`, `connect`, and one `signTransaction` method. It does not expose a send method. `connect` reads a public key only. It does not read a cluster from the provider, and it does not read private key fields. The public key is an identity. It is not a network. `signTransaction` is called only after the Phase 1 pre-sign checks pass, and only with the previously prepared legacy transaction.

`signingHandoff` is null for ALLOW, REVISE, REFUSE, and DENY. Signing readiness is a separate field. ALLOW still carries a frozen `approvedBinding` when the DevNet intent passes the local checks. REVISE, REFUSE, and DENY do not carry `approvedBinding` and do not carry a serialized transaction.

Phase 1 cannot add a sign path on this binding alone. The audit digest has to be extended with exact message bytes before any signature request exists. That extension is the exact-message hash below. The six-field digest is still not a signature authorization.

## Network authority

Phase 0 network authority is the local preview configuration. The only accepted intent network is `devnet`. `mainnet-beta`, `mainnet`, `testnet`, `localnet`, a missing network, and any other value fail closed at the transaction-control layer. The attempted network stays visible. Wallet connection does not supply a network, and a missing or unexpected provider field does not turn constraint ALLOW into DENY.

This matches the DevNet-only posture of the ai4-constrain DevNet end-to-end path. It is stricter than the broader `prepare_transfer` network allowlist in that engine.

Phase 1 network authority is the application RPC endpoint together with transaction construction. The endpoint is the literal `https://api.devnet.solana.com`. The wallet does not supply it. Before any live transaction is constructed, `getGenesisHash()` must equal `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. A mismatch, a missing hash, a fetch error, or a timeout fail-closes, and no transaction is built. The same call is made again immediately before `signTransaction`. A cached success from prepare time is not reused. That second call is the genesis freshness check. It uses the same fail-closed rules and the same 8 second timeout. Phase 0 still exposes `checkDevnetGenesisHash()` as a pure stub. It records that expected hash, leaves `observedGenesisHash` null, and does not call an RPC.

## Binding model

`ApprovedBinding` uses the same fields as `ai4.transaction.types.ApprovedBinding`:

- `network`
- `asset`
- `action`
- `amount_sol`
- `lamports`
- `destination`

The digest is SHA-256 over canonical JSON: object keys sorted, separators comma and colon, no extra whitespace. That matches Python `json.dumps(..., sort_keys=True, separators=(",", ":"))`.

The six-field SHA-256 is an audit digest compatible with ai4-constrain. That digest is not sufficient to authorize a future signature.

Phase 1 must extend the approval before a sign path can exist:

1. Construct the exact Solana message bytes.
2. SHA-256 those bytes.
3. Store that hash with the audit binding.
4. Immediately before Phantom `signTransaction`, serialize the candidate message synchronously.
5. Compare those bytes to the frozen message. That equality is the stored SHA-256 preimage.
6. Call `signTransaction` on that same candidate with no await and no callback between the comparison and the call.
7. Any byte difference drops signing readiness and does not call Phantom.

That exact-message binding covers, by construction, the blockhash, the fee payer, program IDs, account metas, flags, instruction ordering, extra instructions, the amount, the destination, and every other serialized field.

Phase 0 does not construct those message bytes and does not call Phantom to sign. Phase 1 does construct them, and it still cannot add a sign path on the six-field digest alone. The implementation is below.

Locked vector for 0.001 SOL to `4WDYrTNTit9m7kU5y2LWCfvf35pQo9vbjPTDyiDHEq9e` on devnet:

`fe30e76ac25e766f37d4f719caaa7efa7b2603afbf388dbca609154258a37da0`

The serialized transaction in this preview is a deterministic stub string, kind `solana_system_transfer_stub`. It is not a Solana wire transaction and it cannot be submitted. If that string changes after ALLOW, the recheck fails closed and drops the binding.

Amount text is normalized the same way as `format_sol_amount` (trailing zeros removed). A change of lamports, destination, or network fails closed. An equivalent spelling such as `0.0010` still matches `0.001`.

## Frozen ALLOW snapshot

An ALLOW result freezes the binding, the serialized preview stub, both hashes, the approved form state, and the wallet session captured at approval. `Object.freeze` covers the snapshot and the nested binding and form. Assignment to those fields throws. Recheck reads that snapshot. It also receives the current wallet session and computes signing readiness from that current session. It does not keep a stale readiness value from the page.

A post-ALLOW change to amount, destination, network, or the serialized stub fails closed and drops the binding. A post-ALLOW change to the wallet session keeps a matching constraint ALLOW and drops signing readiness to unavailable.

## Constraint result and signing readiness

Fixtures stand in for a constrain decision. Signing readiness is not that decision.

| Situation | Constraint result | Binding | Signing readiness |
| --- | --- | --- | --- |
| ALLOW, wallet disconnected | ALLOW | present, frozen | unavailable |
| ALLOW, wallet connected | ALLOW | present, frozen | not_ready |
| REVISE | REVISE | absent | unavailable |
| REFUSE | REFUSE | absent | unavailable |
| local guard failure | not applied; transaction control DENY | absent | unavailable |
| ready | not used in Phase 0 | | |

Phase 0 never returns `ready`. Live signing is disabled.

A disconnected wallet can show constraint ALLOW and signing readiness unavailable. A missing wallet session does not turn constraint ALLOW into DENY.

A connected public key with constraint ALLOW is `not_ready`, because Phase 0 does not request a signature and the exact message bytes are not bound.

The Python engine maps constrain `revise` and `refuse` onto product DENY and withholds handoff URIs. This preview shows REVISE and REFUSE directly so those outcomes stay visible. It still withholds the binding and any signing handoff.

## Verify interface

`readVerifyStatus()` returns interface `ai4.verify.preview.v0`, mode `preview`, label `Preview`, `productionVerifierActive: false`, `productionCalled: false`, and `unsWrites: false`. There is no production client and no name-system writer.

The view renders Verify from `evaluation.verify`: "Identity verification: Preview / Production verifier not active."

The UI does not show a VERIFIED status.

## Wallet adapter

`WalletAdapter` has `id`, `chainFamily` (`solana` or `evm`), `detect`, and `connect`. Phase 0 registers Phantom only. `connect` returns identity only. A later transport can implement the same interface. Those adapters are not included.

## Amount cap

Native SOL transfer only. The Phase 0 cap is 0.01 SOL, the same cap as the DevNet end-to-end proof. Larger amounts fail closed.

## Reference engine, read only

TheSingulant/ai4-constrain:

- `ai4/transaction/types.py` (`NormalizedIntent`, `ApprovedBinding`, canonical sha256)
- `ai4/transaction/binding.py` (fail closed when the handoff does not match the approved intent)
- `ai4/transaction/handoff.py` (unsigned handoff, no keys)
- `ai4/transaction/firewall.py` (ALLOW versus fail closed)
- `ai4/transaction/prepare.py` (DENY carries no unsigned payload)
- `ai4/transaction/validate.py` (deterministic checks)
- `ai4/transaction/receipt.py`, `status.py` (lifecycle observation, not used at runtime here)
- `ai4/transaction/desktop_handoff.py`, `devnet_e2e.py` (DevNet-only proof posture)
- `docs/transaction-control.md`
- `docs/transaction-devnet-e2e.md`

This repository reimplements the six-field audit digest in TypeScript for a static preview. It does not import the package and it does not call it. The desktop handoff is a read-only reference for the DevNet genesis check. Phase 0 does not perform that check. Phase 1 performs it against the app DevNet RPC and calls Phantom `signTransaction` only for the prepared message. It does not broadcast.

## Phase 1 signing path

```
ALLOW snapshot (unchanged six-field audit digest)
  -> connected Phantom identity
  -> app DevNet getGenesisHash()
  -> app DevNet getLatestBlockhash()
  -> one legacy SystemProgram.transfer
  -> SHA-256 of serializeMessage()
  -> signing readiness ready
  -> explicit Sign transaction click
  -> Sign and Prepare disabled for that attempt
  -> fresh getGenesisHash()
  -> blockhash still valid, not replaced
  -> fresh Phantom public key equals the prepared fee payer
  -> synchronous critical section:
       serializeMessage()
       byte-for-byte equality with the frozen message
       those bytes are the stored SHA-256 preimage
       Phantom signTransaction on that same Transaction
       no await and no readiness callback between the compare and the call
  -> verify the returned fee-payer signature over that message
  -> local signed bytes in memory
```

No step calls `sendTransaction`, `sendRawTransaction`, or `signAndSendTransaction`.

### Transaction format

Phase 1 uses the classic `Transaction` from `@solana/web3.js`, not `VersionedTransaction`. A native SOL transfer is one system instruction. It does not need address lookup tables. `serializeMessage()` is the exact message. Immediately before `signTransaction`, that message is compared to the frozen bytes and the matching Transaction is the one passed to Phantom. A field lookalike is not substituted. The critical section does not await and does not run a readiness callback between the comparison and the call.

The transfer cap stays 0.01 SOL, the Phase 0 cap. The fee payer is the connected Phantom public key. The instruction list is only `SystemProgram.transfer`. The hashed bytes include the fee payer, recent blockhash, program id, account metas, header flags, instruction ordering, recipient, and lamports.

### Prepared state

The prepared record is frozen. It stores the fee payer, the six-field `ApprovedBinding` and its audit hash, the exact message bytes, the message hash, the blockhash, the last valid block height, the DevNet genesis hash, and a timestamp. Message bytes are copied on read. The sealed `Transaction` stays beside that record so a later mutation can be detected. Phantom receives a restoration of the frozen message bytes, created inside the critical section, and only when that restoration and the sealed transaction both serialize to those bytes.

### Blockhash expiry

A new blockhash produces a new message hash. When the stored blockhash is no longer valid, when the current block height is past `lastValidBlockHeight`, or when that check errors or times out, signing readiness becomes unavailable and the session drops the prepared record. The old record is not edited. Its blockhash is not replaced. A later prepare builds a new record and advances a monotonic signing generation. A sign attempt captures that generation and the prepared record it intends to sign. After every await, and again in the synchronous section immediately before `signTransaction`, the attempt aborts when the generation changed, the session no longer holds that same record, the form no longer matches, or the constraint result is no longer ALLOW. Phantom is not called. An in-flight attempt does not sign a record the page has replaced or dropped.

The sign path does not call `getLatestBlockhash`. Rebuild is a new prepare.

### Readiness

Constraint result and signing readiness stay separate. Phase 1 states are `unavailable`, `preparing`, `ready`, `signing`, `signed`, and `failed`. ALLOW is not ready. Ready requires a connected Phantom identity, a passed genesis check, constraint ALLOW, a valid six-field binding, a built exact message, a stored message hash, and a form that still matches. A wallet, fixture, network, or form change drops the session to unavailable and clears the prepared state. A failed Phantom prompt stays `failed` until a new prepare. It is not signed again.

### After sign

The signature and the signed transaction bytes stay on the in-memory session. `broadcast` is false. Nothing is written to local storage. Verify stays on the Preview stub.

## New components

- Vite + TypeScript preview
- DevNet product guard
- Fixture constraint UI for ALLOW, REVISE, and REFUSE
- Signing readiness, separate from the constraint result
- Phantom detect and connect identity stub
- Frozen post-ALLOW recheck, including the current wallet session
- DevNet genesis-hash stub with no RPC, kept for the Phase 0 evaluator
- Live DevNet genesis check before build and again before sign
- Legacy SOL transfer, exact-message SHA-256, and one Phantom `signTransaction` call
- Verify preview stub

## Out of scope

Broadcast, staking, swaps, WalletConnect, MetaMask, account abstraction, custody, server signing, production hosting, mainnet, production Verify, UNS writes, and changes to ai4-constrain.
