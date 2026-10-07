# Threat model

Phase 0 of AI⁴ Wallet Preview. This note lists what the page is trying to prevent. It does not claim a trust conclusion the code has not established.

## Assets

- The user's authority to sign. This page must not obtain it.
- The approved transfer parameters: network, asset, action, amount, destination, and the serialized preview stub.
- Status honesty. The page must not present a VERIFIED identity state, and it must not present signing readiness ready.

The page does not hold funds. There is no key store.

## Boundaries

| Boundary | How Phase 0 treats it |
| --- | --- |
| Browser page | Displays fixtures and local checks. It is not the constrain engine and it is not a wallet. |
| Injected provider | May expose signing methods and key material. The adapter must not call or read them. |
| Wallet identity | Public key and connection state only. Not a network. |
| Constraint fixtures | Local stand-ins. They are not a live `ai4.constrain` evaluation. |
| Signing readiness | unavailable or not_ready. ready is unused. |
| ALLOW snapshot | Frozen binding, stub, hashes, approved form, and approval-time session. |
| Verify stub | Returns Preview only. It has no production endpoint. |
| Network label | Stays visible, including when the value is not DevNet. The label comes from the intent, not from the wallet. |

## Threats and what the code does

1. **Mainnet or any non-DevNet intent.** The DevNet guard returns DENY, clears the binding, and clears the serialized stub. The attempted network remains on screen. Signing readiness is unavailable.

2. **Treating the wallet as the network.** The adapter does not read a cluster from the provider. A public key is identity only. The preview network stays the local DevNet configuration. A connected or disconnected wallet does not change that network and does not by itself turn constraint ALLOW into DENY. Signing readiness stays unavailable or not_ready. Phase 0 has no ready state. Phase 1 must check `getGenesisHash()` against `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` before constructing a transaction. The Phase 0 stub does not call an RPC.

3. **Parameter swap after ALLOW.** `recheckAfterAllow` receives the current wallet session and compares network, canonical amount, destination, and the serialized stub with the frozen snapshot. Any field difference returns DENY and drops the binding and the stub. A wallet session change after ALLOW keeps a matching constraint ALLOW and sets signing readiness to unavailable. A binding whose stored sha256 does not match a fresh canonical digest also fails closed. The frozen snapshot rejects property assignment.

4. **REVISE, REFUSE, or DENY carrying a signing payload.** Those decisions set `approvedBinding`, `serializedTx`, and `signingHandoff` to null, and signing readiness to unavailable. ALLOW sets `signingHandoff` to null as well. Connected ALLOW is `not_ready`. Disconnected ALLOW is `unavailable`. Phase 0 does not hand off for signing.

5. **Private key or signature request.** The adapter reads `isPhantom`, `connect`, and the returned public key. It does not read a cluster. Tests trap access to key fields, cluster, and signature methods, including bracket access. The `src` tree does not call those methods.

6. **Custody or server-side signing flags.** Those intents are DENY. No binding is issued. Signing readiness is unavailable.

7. **Production Verify or a name-system write.** The Verify module returns fixed Preview flags. It does not call `fetch`. `unsWrites` is false. There is no writer. The view renders the status from `evaluation.verify`.

8. **A false VERIFIED label.** Product copy uses "Identity verification: Preview / Production verifier not active." A test scans the view text for the status word VERIFIED and for the words secure, safe, and trusted.

9. **Hiding the network.** The network banner is part of every view, including a mainnet attempt. The banner is the intent network.

10. **Mutating an ALLOW snapshot.** Binding, serialized stub, hashes, and approved form state are frozen. A later write does not change the approved bytes.

## Residual risk

- Fixtures are not the live constrain engine. A later phase has to run the real evaluator. This page must not be treated as that result.
- The preview does not ask an RPC for genesis. The stub records the expected DevNet genesis and leaves the check unperformed. Phase 1 has to perform it before transaction construction.
- The serialized field is a preview stub, not a Solana message. The six-field digest does not authorize a signature. Phase 1 has to hash the exact message bytes and recompute them immediately before a signature request.
- Signing readiness is separate from constraint ALLOW. Phase 0 never sets ready. A later phase still has to extend the binding before it can.
- A person can still be misled by a lookalike site. This repository does not host a production origin.
- Dependency risk remains. CI runs tests, typecheck, build, and a pattern secret scan. That scan is not a full secret-management program.

## Non-goals

This model does not cover staking, swaps, WalletConnect, MetaMask, account abstraction, hosted signing, mainnet, or production identity proof. Those features are not in the tree.
