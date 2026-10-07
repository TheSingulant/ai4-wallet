# AI⁴ Wallet Preview

Constrain authority before you sign.

You sign. AI⁴ cannot move funds.

Phase 0 is a DevNet-only browser preview of transaction-control checks. It is not a wallet.

Identity verification: Preview / Production verifier not active.

## Non-custodial boundaries

- This repository does not create, store, or read private keys.
- This repository does not sign transactions and does not send them.
- This repository does not custody funds and does not sign on a server.
- Mainnet is not enabled. An intent that is not `devnet` fails closed.
- Production Verify is not called. The status line stays on Preview.
- This repository does not write Unstoppable name records.
- This repository does not deploy a host.
- The frontend is not part of TheSingulant/ai4-constrain, and this work does not change that repository.

## What Phase 0 can show

- A static SOL transfer fixture.
- ALLOW, REVISE, or REFUSE from that fixture.
- DENY when the DevNet guard or a post-ALLOW recheck fails.
- Phantom detection and a connect stub that stops at a public key.
- A comparison of amount, destination, network, and the serialized preview stub against the ALLOW binding.

## Develop

Requires Node 22 or newer.

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
