# ODAR-Stream v2 — Format and Migration Contract

Status: implementation in progress. This document defines the v2 stream framing contract; it does not mean the production backup path is already streaming.

## Non-negotiable rules

- Keep the existing ODBK/ODAR v1 reader intact. Existing v1 backup objects remain readable and are not rewritten in place.
- Use an independent per-backup key derived with HKDF-SHA256 from the configured 32-byte master key, a random 128-bit salt, and the backup identity. Use AES-256-GCM with a 96-bit monotonically increasing nonce for each frame under that derived key.
- Authenticate the Dot ID, backup ID, backup type, format/version metadata, chunk sequence and chunk length as associated data for every data frame. Authenticate the final manifest too.
- The final manifest contains the exact frame count, total decrypted byte count and SHA-256 digest of the framed plaintext stream. A stream is not complete until its manifest tag verifies, lengths/digest match, and EOF immediately follows.
- A consumer must write decoded bytes to an isolated staging destination. Do not apply any decoded chunk to live workspace/profile files while the final manifest is still unverified. Complete archive parsing and validation before committing staged data.
- If the disk budget cannot hold the chosen staging strategy, fail before changing live data. Do not claim zero staging cost.
- Every stream, compression, encryption, network and filesystem stage must honour cancellation and bounded backpressure. An aborted B2 multipart upload must be explicitly aborted.
- V2 support stays opt-in until all production layers are integrated and tested. Never silently route a v1 object through the v2 decoder or vice versa.

## Binary framing

All multi-byte integer fields are unsigned, big-endian. The current implementation uses an 8-byte magic value `ODAR2S\r\n`, followed by a 4-byte header length and a bounded UTF-8 JSON header. The header identifies the v2 version, Dot/backup/type, content encoding, logical chunk size and random HKDF salt. Header metadata is serialized canonically and included in every frame's associated data.

A data frame is:

`0x01 | sequence:uint64 | plaintextLength:uint32 | ciphertext[plaintextLength] | GCM tag[16]`

Frames must have contiguous sequence numbers starting at zero. Empty data frames, frames larger than the advertised chunk size, duplicate frames and reordered frames are rejected.

The final manifest frame is:

`0xFF | chunkCount:uint64 | totalPlaintextBytes:uint64 | SHA-256[32] | GCM tag[16]`

The final tag authenticates the header context, frame type, counts, byte length and digest. The final frame uses the next sequence nonce after the last data frame. Any missing manifest, invalid tag, digest/length mismatch, identity mismatch or trailing byte rejects the stream.

The logical chunk size defaults to 5 MiB. B2 multipart upload assembly is a separate transport concern: non-final multipart parts must respect B2's minimum part size, so the B2 adapter may need to coalesce framed output into multipart parts under strict bounded buffering. A logical encrypted frame is not itself a promise that it equals one multipart part.

## Integration sequence

1. Implement and test the versioned authenticated framing module.
2. Add stream-oriented APIs alongside current v1 Buffer APIs; do not break v1 call sites while migration is in flight.
3. Implement B2 multipart write/read streams with backpressure, part coalescing, abort cleanup, and no full-object accumulation.
4. Replace provider/supervisor archive Buffer boundaries with stream transports and an archive format that can be generated/parsed incrementally.
5. Add a transaction protocol: preflight disk budget, authenticate and stage to isolated storage, validate the complete archive and final manifest, then commit/swap with rollback. Keep live files untouched until all validation succeeds.
6. Run V1 fixture restore tests, V2 framing adversarial tests, multipart abort tests, archive restore fault-injection tests and live end-to-end qualification.
7. Only after all five layers pass, enable v2 production backups. V1 restore remains enabled.

## Acceptance gates

- Fragmented source/network chunks do not affect parsing.
- Wrong Dot/backup/type, wrong key, duplicate/reordered/missing frames, corrupt ciphertext/tag, corrupt manifest, truncation and trailing data are rejected.
- A rejected stream never commits staged data or mutates live files.
- V1 fixtures remain readable.
- A large-payload integration run demonstrates bounded RSS and bounded disk high-water mark, with measured values reported as results rather than estimates.
