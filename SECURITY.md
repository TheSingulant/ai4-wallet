# Security

## Reporting a vulnerability

Report suspected vulnerabilities privately by email to support@thesingulant.ai.

Do not publicly disclose an exploitable wallet issue (in an issue, pull request, discussion or post) before we have coordinated a fix with you. Do not include private keys, seed phrases or credentials in any report.

## Scope

In scope: the AI⁴ Wallet Preview source code in this repository.

The current release is Phase 1.2 and has these boundaries:

- Solana DevNet only. Mainnet is not enabled.
- Local signature only, in the user's Phantom wallet.
- No broadcast. The preview does not send transactions.
- No private key or seed custody. The preview does not create, store or read private keys.
- No server signing.
- No production Verify dependency.

Reports showing that any of these boundaries can be bypassed are in scope and especially welcome.

Out of scope: Phantom, Solana RPC providers and other third-party software, social engineering, and systems not shipped in this repository.

## What this policy does not claim

This preview has not undergone a security audit or certification and is not represented as safe for mainnet use or ready for mainnet. There is no bug bounty program. Reports are handled through responsible, coordinated disclosure.
