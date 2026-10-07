# Phase 1 note

Phase 1 adds a DevNet connect and sign path. It does not broadcast.

The app owns the network. The RPC URL is `https://api.devnet.solana.com`. The wallet remains an identity: connected or not, a public key, and a source. Before a transaction is built, `getGenesisHash()` must equal `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. The same call runs again immediately before Phantom `signTransaction`. A cached boolean is not freshness. Mismatch, a missing hash, a fetch error, and timeout all fail closed.

The transaction is a classic `Transaction`. `VersionedTransaction` is not used. A native SOL transfer does not need address lookup tables, and `serializeMessage()` is the exact message. The Phase 0 cap of 0.01 SOL is unchanged.

The six-field `ApprovedBinding` SHA-256 stays the audit digest, including the known vector for 0.001 SOL. It does not authorize a signature. The sign path requires a second SHA-256 over the legacy message bytes.

Pre-sign recheck reserializes that same transaction, recomputes the hash, and requires equality. A mismatch clears readiness and the prepared state. Phantom is not called. The object passed to `signTransaction` is the prepared instance, not a reconstructed lookalike.

Blockhash expiry does not edit the old prepared record. Readiness drops to unavailable. A new prepare builds a new record. The old record cannot be signed.

Verify stays on the Preview stub. There is no production verifier call and no UNS write.
