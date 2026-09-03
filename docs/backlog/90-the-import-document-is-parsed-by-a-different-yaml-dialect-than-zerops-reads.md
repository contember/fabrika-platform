---
id: 90
title: The import document is parsed by a different YAML dialect than Zerops reads
blocked-by: []
---

# 90 — The import document is parsed by a different YAML dialect than Zerops reads

**Summary.** Every witness on the Zerops import path — the manifest parser, the descriptor walk for
cross-service references, the emitter's round-trip test — reads YAML with `Bun.YAML.parse`, a YAML
1.2 parser. Zerops parses with go-yaml, a YAML 1.1 parser (its error text is quoted in
[`reference/zerops-platform.md`](../reference/zerops-platform.md)). Where the two dialects disagree,
fabrika checks one document and Zerops runs another. The line-break half (U+2028, U+2029, U+0085,
C1 controls) is closed in the emitter and the variable bound; the rest is not. Effort M.

## Problem

- `packages/provider-zerops/src/manifest.ts:251` `parseDescriptorDocument` parses the embedded
  `zerops.yaml` with `Bun.YAML.parse` and walks the result for `${host_KEY}` references. A `!!binary`
  tagged scalar stays base64 text in Bun; go-yaml decodes it to bytes when the target is a string, so
  `!!binary <base64 of ${proxy_FABRIKA_IAM_KEY}>` is invisible to the walk and live on the service.
  Unverified against a real account; the shape is the same as the closed line-break gap.
- Duplicate mapping keys: Bun keeps the last, yaml.v3 errors, yaml.v2 keeps the last. A first-wins
  parser would hide a reference; none of the known ones is, so this half is Low.
- The emitter (`compile.ts`) is now exact for both dialects on line breaks; nothing pins the rest of
  the 1.1/1.2 differences (sexagesimal ints, `y`/`n` booleans, merge keys) beyond the plain-scalar
  reserved list.

## Approach / acceptance

Refuse the dialect, not each feature: at descriptor parse, reject any explicit tag (`!!binary`,
`!!merge`, `!` local tags) and any anchor or alias — an app's `zerops.yaml` needs none of them — and
fail closed on a document that does not re-serialise to itself through the emitter. For the emitter,
add a 1.1-reader assertion to its round-trip tests (a fixture set parsed by go-yaml in a scratch
harness, or a pinned corpus of rendered documents with their expected 1.1 parse). Acceptance: a
descriptor carrying a `!!binary` reference is refused at registration naming the tag; the emitter's
corpus test lists the code points and constructs it is exact for.

## Touch points

- `packages/provider-zerops/src/manifest.ts` — `parseDescriptorDocument`, `foreignReferenceInValue`.
- `packages/provider-zerops/src/compile.ts` — `scalar`, `blockScalarSafe`, `renderYaml`.
- `packages/provider-zerops/src/__tests__/` — the corpus.

<!-- Origin: security review 2026-09-02, findings C1 (A7-1) and H7 (A7-2); the dialect residue found by the closure validation of 2026-09-03. -->
