# Phase 1 note

Phase 1 adds a DevNet connect and sign path. It does not broadcast.

The app owns the network. The RPC URL is `https://api.devnet.solana.com`. The wallet remains an identity: connected or not, a public key, and a source. Before a transaction is built, `getGenesisHash()` must equal `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. The same call runs again immediately before Phantom `signTransaction`. A cached boolean is not freshness. Mismatch, a missing hash, a fetch error, and timeout all fail closed.

The transaction is a classic `Transaction`. `VersionedTransaction` is not used. A native SOL transfer does not need address lookup tables, and `serializeMessage()` is the exact message. The Phase 0 cap of 0.01 SOL is unchanged.

The six-field `ApprovedBinding` SHA-256 stays the audit digest, including the known vector for 0.001 SOL. It does not authorize a signature. The sign path requires a second SHA-256 over the legacy message bytes.

The pre-sign critical section is synchronous. It serializes the candidate, compares those bytes to the frozen message, and calls `signTransaction` on that same object. There is no await and no readiness callback between the comparison and the call. The candidate is restored from the frozen message bytes, and only if that restoration matches. A mutated sealed transaction fails closed. A field lookalike is not what Phantom receives.

Blockhash expiry does not edit the old prepared record. Readiness drops to unavailable. A new prepare builds a new record and advances the signing generation. An attempt captures the generation and the prepared record it intends to sign. If either no longer matches, the attempt aborts before Phantom.

Verify stays on the Preview stub. There is no production verifier call and no UNS write.
