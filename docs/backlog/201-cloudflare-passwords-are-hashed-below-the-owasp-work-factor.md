---
id: 201
title: Cloudflare passwords are hashed below the OWASP work factor
blocked-by: []
---

# 201 — Cloudflare passwords are hashed below the OWASP work factor

**Summary.** A Worker caps PBKDF2 at 100 000 iterations, so IAM on Cloudflare hashes passwords at a sixth of OWASP's
600 000 for PBKDF2-HMAC-SHA256. Hash with Argon2id through WASM on both runtimes. P3, size M.

## Problem

`PBKDF2_SHA256_ITERATIONS` (`packages/iam/src/password-crypto.ts`) asked for 600 000 iterations on every path (hash,
verify, the dummy hash of an unknown account). Production workerd refuses PBKDF2 above 100 000 iterations
(`DEFAULT_MAX_PBKDF2_ITERATIONS`); standalone workerd and Bun do not, so no local test sees it. The fix of that
failure picks the cost per runtime in the composition: `PBKDF2_SHA256_WORKERS_MAX_ITERATIONS` (100 000) on a Worker,
600 000 on Bun. Password login on Cloudflare then works, but its verifiers are about six times cheaper to brute-force
than OWASP's PBKDF2 floor, and than the same installation's verifiers on Zerops.

Nothing in the schema blocks a change: each verifier stores its `algorithm` and `parameters`, and a successful login
with `needsRehash` replaces the verifier (`packages/iam/src/auth/password.ts:137-160`).

## Approach / acceptance

Add an Argon2id hasher (OWASP: m = 19 MiB, t = 2, p = 1) from a WASM build that runs on both runtimes, and make it the
current algorithm for new hashes; PBKDF2 stays a verify-only algorithm whose valid login answers `needsRehash`. To
decide first:

- The dependency: a maintained WASM Argon2id that loads in a Worker bundle and in Bun, its size, and its pin.
- Memory: 19 MiB per derivation against a 128 MB isolate, and how many concurrent logins one isolate takes. The global
  and account login buckets bound the rate, not the concurrency.
- CPU: the Worker's CPU time limit per request at t = 2.
- The rehash wave on Zerops: every PBKDF2 verifier is replaced at its next login, which revokes that principal's
  older password sessions (the comment at `password.ts:154`). Decide whether a rehash keeps sessions instead.

Rollout on an existing installation: no migration and no environment variable. Existing verifiers keep verifying and
move to Argon2id on their next successful login; a principal who never logs in keeps a PBKDF2 verifier.

Witness: a test that hashes and verifies through the Worker build under workerd's production PBKDF2 limit (or a smoke
login on a real Cloudflare stage), and a `password-crypto` test that a PBKDF2 verifier verifies, answers
`needsRehash`, and the rehash stores Argon2id.

## Touch points

`packages/iam/src/password-crypto.ts`, `packages/iam/src/auth/password.ts`, the IAM composition roots of both
runtimes, `docs/reference/human-authentication.md` (it names PBKDF2), `packages/iam/package.json` (the new
dependency).

<!-- Origin: a platform review; the Worker PBKDF2 ceiling was fixed per runtime first. -->
