# Threat model

Phase 0 and Phase 1 of AI⁴ Wallet Preview. This note lists what the page is trying to prevent. It does not claim a trust conclusion the code has not established.

## Assets

- The user's authority to sign. The page must not hold key material. Phantom signs after an explicit click.
- The approved transfer parameters: network, asset, action, amount, destination, and the serialized preview stub.
- Status honesty. The page must not present a VERIFIED identity state. "Genesis verified" is shown only after `getGenesisHash()` returns `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.

The page does not hold funds. There is no key store.

## Boundaries

| Boundary | How Phase 0 treats it |
| --- | --- |
| Browser page | Displays fixtures and local checks. It is not the constrain engine and it is not a wallet. |
| Injected provider | May expose signing methods and key material. Connect must not call or read them. Phase 1 calls `signTransaction` only. |
| Wallet identity | Public key and connection state only. Not a network. |
| Constraint fixtures | Local stand-ins. They are not a live `ai4.constrain` evaluation. |
| Signing readiness | Phase 0 evaluator: unavailable or not_ready. Phase 1 session: unavailable, preparing, ready, signing, signed, or failed. ALLOW is not ready. |
| ALLOW snapshot | Frozen binding, stub, hashes, approved form, and approval-time session. |
| Verify stub | Returns Preview only. It has no production endpoint. |
| Network label | Stays visible, including when the value is not DevNet. The label comes from the intent, not from the wallet. |

## Threats and what the code does

1. **Mainnet or any non-DevNet intent.** The DevNet guard returns DENY, clears the binding, and clears the serialized stub. The attempted network remains on screen. Signing readiness is unavailable.

2. **Treating the wallet as the network.** The adapter does not read a cluster from the provider. A public key is identity only. The network is the app DevNet RPC `https://api.devnet.solana.com`. A connected or disconnected wallet does not change that network and does not by itself turn constraint ALLOW into DENY. Before a transaction is built, and again immediately before `signTransaction`, `getGenesisHash()` must equal `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. A mismatch, a missing hash, a fetch error, or a timeout fail-closes. The Phase 0 stub still does not call an RPC.

3. **Parameter swap after ALLOW.** `recheckAfterAllow` receives the current wallet session and compares network, canonical amount, destination, and the serialized stub with the frozen snapshot. Any field difference returns DENY and drops the binding and the stub. A wallet session change after ALLOW keeps a matching constraint ALLOW and sets signing readiness to unavailable. A binding whose stored sha256 does not match a fresh canonical digest also fails closed. The frozen snapshot rejects property assignment.

4. **REVISE, REFUSE, or DENY carrying a signing payload.** Those decisions set `approvedBinding`, `serializedTx`, and `signingHandoff` to null, and signing readiness to unavailable. ALLOW sets `signingHandoff` to null as well. Connected ALLOW is `not_ready`. Disconnected ALLOW is `unavailable`. Phase 0 does not hand off for signing.

5. **Private key or an unsolicited signature request.** Connect reads `isPhantom`, `connect`, and the returned public key. It does not read a cluster. Tests trap access to key fields, cluster, and signature methods during connect, including bracket access. Phase 1 adds one `signTransaction` call. It does not call `signAndSendTransaction`, `signAllTransactions`, or `signMessage`. The call happens only after an explicit click and only after the pre-sign recheck.

6. **Custody or server-side signing flags.** Those intents are DENY. No binding is issued. Signing readiness is unavailable.

7. **Production Verify or a name-system write.** The Verify module returns fixed Preview flags. It does not call `fetch`. `unsWrites` is false. There is no writer. The view renders the status from `evaluation.verify`.

8. **A false VERIFIED label.** Product copy uses "Identity verification: Preview / Production verifier not active." The words secure, safe, and trusted are not used. "Genesis verified" is rendered only when the genesis check has passed.

9. **Hiding the network.** The network banner is part of every view, including a mainnet attempt. The banner is the intent network.

10. **Mutating an ALLOW snapshot.** Binding, serialized stub, hashes, and approved form state are frozen. A later write does not change the approved bytes.

11. **Signing a different message than the one that was prepared.** The pre-sign step reserializes the same `Transaction` and recomputes SHA-256. Any byte difference drops signing readiness, clears the prepared state, and does not call Phantom.

12. **A silent blockhash replacement.** Expiry invalidates readiness. The old blockhash stays on the old record. Rebuild creates a new prepared state. The old state cannot be signed.

13. **Broadcast or `signAndSendTransaction`.** Those calls are absent. The signed bytes stay in memory. `broadcast` on the local result is false.

14. **A stale genesis success.** Prepare-time success is not reused at sign time. Freshness is a new `getGenesisHash()` call.

## Residual risk

- Fixtures are not the live constrain engine. A later phase has to run the real evaluator. This page must not be treated as that result.
- Phase 0 still does not ask an RPC for genesis. Phase 1 does, against the app DevNet endpoint, and fail-closes when the check does not pass.
- The Phase 0 serialized field is still a preview stub. The six-field digest does not authorize a signature. Phase 1 hashes `serializeMessage()` and recomputes it immediately before `signTransaction`.
- Signing readiness is separate from constraint ALLOW. The Phase 0 evaluator never sets ready. The Phase 1 session reaches ready only with the exact message bound.
- A signed result is not a broadcast transaction. A later phase must not treat these in-memory bytes as permission to send.
- A person can still be misled by a lookalike site. This repository does not host a production origin.
- Dependency risk remains. CI runs tests, typecheck, build, and a pattern secret scan. That scan is not a full secret-management program.

## Non-goals

This model does not cover staking, swaps, WalletConnect, MetaMask, account abstraction, hosted signing, mainnet, or production identity proof. Those features are not in the tree.
