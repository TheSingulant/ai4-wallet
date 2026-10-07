# Threat model

Phase 0 of AI⁴ Wallet Preview. This note lists what the page is trying to prevent. It does not claim a trust conclusion the code has not established.

## Assets

- The user's authority to sign. This page must not obtain it.
- The approved transfer parameters: network, asset, action, amount, destination, and the serialized preview stub.
- Status honesty. The page must not present a VERIFIED identity state.

The page does not hold funds. There is no key store.

## Boundaries

| Boundary | How Phase 0 treats it |
| --- | --- |
| Browser page | Displays fixtures and local checks. It is not the constrain engine and it is not a wallet. |
| Injected provider | May expose signing methods and key material. The adapter must not call or read them. |
| Constraint fixtures | Local stand-ins. They are not a live `ai4.constrain` evaluation. |
| Verify stub | Returns Preview only. It has no production endpoint. |
| Network label | Stays visible, including when the value is not DevNet. |

## Threats and what the code does

1. **Mainnet or any non-DevNet intent.** The DevNet guard returns DENY, clears the binding, and clears the serialized stub. The attempted network remains on screen.

2. **Wallet cluster is not DevNet, or the cluster was not reported.** A connected session fails closed. The binding is not kept. A disconnected session can still show an ALLOW fixture for a DevNet intent. The signing handoff stays empty, with an explicit disconnected reason.

3. **Parameter swap after ALLOW.** `recheckAfterAllow` compares network, canonical amount, destination, and the serialized stub. Any difference returns DENY and drops the binding and the stub. A binding whose stored sha256 does not match a fresh canonical digest also fails closed.

4. **REVISE, REFUSE, or DENY carrying a signing payload.** Those decisions set `approvedBinding`, `serializedTx`, and `signingHandoff` to null. ALLOW sets `signingHandoff` to null as well, because Phase 0 does not hand off for signing.

5. **Private key or signature request.** The adapter reads `isPhantom`, `connect`, the returned public key, and an optional `cluster` string. Tests trap access to key fields and signature methods. The `src` tree does not call those methods.

6. **Custody or server-side signing flags.** Those intents are DENY. No binding is issued.

7. **Production Verify or a name-system write.** The Verify module returns fixed Preview flags. It does not call `fetch`. `unsWrites` is false. There is no writer.

8. **A false VERIFIED label.** Product copy uses "Identity verification: Preview / Production verifier not active." A test scans the view text for the status word VERIFIED and for the words secure, safe, and trusted.

9. **Hiding the network.** The network banner is part of every view, including a mainnet attempt.

## Residual risk

- Fixtures are not the live constrain engine. A later phase has to run the real evaluator. This page must not be treated as that result.
- The wallet cluster hint is whatever the provider reports. Phase 0 fails closed when it is missing or not `devnet`. It does not query a chain to confirm the cluster.
- The serialized field is a preview stub, not a wire transaction. It does not prove what a wallet would later encode.
- A person can still be misled by a lookalike site. This repository does not host a production origin.
- Dependency risk remains. CI runs tests, typecheck, build, and a pattern secret scan. That scan is not a full secret-management program.

## Non-goals

This model does not cover staking, swaps, WalletConnect, MetaMask, account abstraction, hosted signing, mainnet, or production identity proof. Those features are not in the tree.
