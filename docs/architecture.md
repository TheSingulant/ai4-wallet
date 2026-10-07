# Architecture

## Recommendation

Phase 0 lives in the public repository TheSingulant/ai4-wallet. The browser UI stays separate from TheSingulant/ai4-constrain. This repository does not modify ai4-constrain, does not vendor it, and does not put a frontend inside it.

## What this is

A non-custodial web preview. It shows a DevNet transaction intent, a fixture constraint result, and an approved binding before a person would sign in their own wallet. AI⁴ does not hold keys and does not move funds.

Phase 0 is fixture-driven. It does not call the Python constrain engine, a production verifier, or a chain RPC.

## Flow

```
fixture intent
  -> DevNet guard
  -> deterministic checks (asset, action, amount, destination, custody flags)
  -> fixture constraint result ALLOW | REVISE | REFUSE
  -> on ALLOW only: ApprovedBinding + sha256
  -> recheck if amount, destination, network, or serialized tx changes
  -> Phantom detect / connect stub
  -> Verify status: Preview
```

The signing handoff stays empty. The page does not request a signature and does not send a transaction.

## Signing boundary

The wallet adapter interface exposes `detect` and `connect`. It does not expose a sign method or a send method. `connect` may read a public key and an optional cluster hint from an injected Phantom provider. It does not read private key fields.

`signingHandoff` is null for ALLOW, REVISE, REFUSE, and DENY. ALLOW still carries `approvedBinding` when the DevNet intent passes the local checks. REVISE, REFUSE, and DENY do not carry `approvedBinding` and do not carry a serialized transaction.

A later phase can add a sign path on a new method without replacing the preview, the binding model, or the adapter interface. That path is not present here.

## DevNet guard

Phase 0 accepts only the cluster `devnet`. `mainnet-beta`, `mainnet`, `testnet`, `localnet`, a missing network, and any other value fail closed. The attempted network stays visible. A connected wallet whose reported cluster is not `devnet` also fails closed, and the ALLOW binding is dropped.

This matches the DevNet-only posture of the ai4-constrain DevNet end-to-end path. It is stricter than the broader `prepare_transfer` network allowlist in that engine.

## Binding model

`ApprovedBinding` uses the same fields as `ai4.transaction.types.ApprovedBinding`:

- `network`
- `asset`
- `action`
- `amount_sol`
- `lamports`
- `destination`

The digest is SHA-256 over canonical JSON: object keys sorted, separators comma and colon, no extra whitespace. That matches Python `json.dumps(..., sort_keys=True, separators=(",", ":"))`.

Locked vector for 0.001 SOL to `4WDYrTNTit9m7kU5y2LWCfvf35pQo9vbjPTDyiDHEq9e` on devnet:

`fe30e76ac25e766f37d4f719caaa7efa7b2603afbf388dbca609154258a37da0`

The serialized transaction in this preview is a deterministic stub string, kind `solana_system_transfer_stub`. It is not a Solana wire transaction and it cannot be submitted. If that string changes after ALLOW, the recheck fails closed and drops the binding.

Amount text is normalized the same way as `format_sol_amount` (trailing zeros removed). A change of lamports, destination, or network fails closed. An equivalent spelling such as `0.0010` still matches `0.001`.

## Constraint result

Fixtures stand in for a constrain decision:

| Fixture | UI | Binding | Signing handoff |
| --- | --- | --- | --- |
| ALLOW | ALLOW | present | none |
| REVISE | REVISE | absent | none |
| REFUSE | REFUSE | absent | none |
| local guard failure | DENY | absent | none |

The Python engine maps constrain `revise` and `refuse` onto product DENY and withholds handoff URIs. This preview shows REVISE and REFUSE directly so those outcomes stay visible. It still withholds the binding and any signing handoff.

## Verify interface

`readVerifyStatus()` returns interface `ai4.verify.preview.v0`, mode `preview`, label `Preview`, `productionVerifierActive: false`, `productionCalled: false`, and `unsWrites: false`. There is no production client and no name-system writer.

UI copy: "Identity verification: Preview / Production verifier not active."

The UI does not show a VERIFIED status.

## Wallet adapter

`WalletAdapter` has `id`, `chainFamily` (`solana` or `evm`), `detect`, and `connect`. Phase 0 registers Phantom only. A later WalletConnect-style transport or an EVM wallet can implement the same interface. Those adapters are not included, so the preview does not need a rewrite to add them later.

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

This repository reimplements the binding contract in TypeScript for a static preview. It does not import the package and it does not call it.

## New components

- Vite + TypeScript preview
- DevNet product guard
- Fixture constraint UI for ALLOW, REVISE, and REFUSE
- Phantom detect and connect stub
- Post-ALLOW recheck, including the serialized stub
- Verify preview stub

## Out of scope

Live sign and send, staking, swaps, WalletConnect, MetaMask, account abstraction, custody, server signing, production hosting, mainnet, production Verify, UNS writes, and changes to ai4-constrain.
