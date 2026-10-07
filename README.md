# AI⁴ Wallet Preview

Constrain authority before you sign.

You sign. AI⁴ cannot move funds.

Phase 1 is a DevNet-only browser preview. It can ask Phantom to sign one prepared SOL transfer. It does not broadcast that transfer. It is not a production wallet.

Identity verification: Preview / Production verifier not active.

## Non-custodial boundaries

- This repository does not create, store, or read private keys.
- Phantom `signTransaction` is the only signature call. It signs the previously prepared message. This repository does not send transactions.
- This repository does not custody funds and does not sign on a server.
- Mainnet is not enabled. An intent that is not `devnet` fails closed. The app RPC is `https://api.devnet.solana.com`. `getGenesisHash()` must equal `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` before a transfer is built, and again before it is signed.
- Production Verify is not called. The status line stays on Preview.
- This repository does not write Unstoppable name records.
- This repository does not deploy a host.
- The frontend is not part of TheSingulant/ai4-constrain, and this work does not change that repository.

## What this preview can show

- A static SOL transfer fixture.
- Constraint result ALLOW, REVISE, or REFUSE from that fixture.
- Phase 0 signing readiness unavailable or not_ready. That evaluator does not reach ready.
- Phase 1 signing readiness unavailable, preparing, ready, signing, signed, or failed. ALLOW is not ready.
- A legacy DevNet SOL transfer, an exact-message SHA-256, and a local Phantom signature. No broadcast.
- DENY when the DevNet guard or a post-ALLOW parameter recheck fails.
- Phantom detection and a connect stub that returns a public key. The public key is not a network.
- A comparison of amount, destination, network, and the serialized preview stub against the frozen ALLOW snapshot, using the current wallet session.

## Develop

Requires Node 22.12.0 or newer.

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run secret-scan
npm run dev
```

## Layout

- `src/domain`: intent, DevNet guard, binding, fixture evaluation, Verify stub
- `src/wallet`: Phantom adapter boundary
- `src/ui`: preview
- `docs/architecture.md`
- `docs/threat-model.md`

## Reference

Binding rules follow the public transaction-control scaffold in TheSingulant/ai4-constrain. That code is a read-only reference. It is not a runtime dependency of this preview.
