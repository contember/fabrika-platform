---
id: 44
title: Make the proxy manifest's build-time delivery quoting-safe
blocked-by: []
---

# 44 — Make the proxy manifest's build-time delivery quoting-safe

**Summary.** The proxy build materializes its manifest with
`printf %s "${FABRIKA_PROXY_MANIFEST_JSON}"`. The value is JSON full of double
quotes, and the `${…}` form is ambiguous between shell expansion and platform
substitution. Under one of those two readings the build writes garbage.

## Problem

[`../../packages/installation-zerops/zerops/setups.ts`](../../packages/installation-zerops/zerops/setups.ts)
builds the proxy with:

```
printf %s "${FABRIKA_PROXY_MANIFEST_JSON}" > ./proxy.manifest.json
```

Zerops resolves `${name}` references in `zerops.yaml`, and the shell resolves
`${name}` in a command it runs. Which one acts here decides the outcome:

- **Shell parameter expansion** — safe. The quotes in the JSON are data.
- **Platform substitution into the command text before the shell sees it** — the
  first `"` inside the JSON closes the string, and the build either fails on a
  syntax error or writes a truncated file.

Upstream distinguishes the two mechanisms for exactly this reason: it documents
shell access to a variable as `$API_URL`, and reserves the `${…}` form for
forwarding a value inside a YAML field. Writing `"$FABRIKA_PROXY_MANIFEST_JSON"`
can only be shell expansion, so it removes the ambiguity at no cost.

There is a second, already-recorded uncertainty stacked on the same line, and it is
the more fundamental one: whether a **build** container can see a service-level
variable at all. The file states it honestly and names the fallback
(materialize in `run.initCommands` instead). Both questions are cheap to answer in
the same live session, and both change the same line.

The fail-closed behaviour downstream is sound and should not change: missing or
malformed JSON makes `generate-config.ts` exit non-zero, the pipeline fails, and the
previous version keeps serving.

## Approach / acceptance

- Rewrite the command in the unambiguous shell form, or materialize the file from a
  `|` block scalar so the value is never spliced into a command line.
- Answer, on a live account, whether the build container sees service-level
  variables. If it does not, move materialization into `run.initCommands` — the
  delivery channel (service-level env API) and the fail-closed parser stay unchanged.
- Add a fixture whose manifest contains quotes, backslashes and a leading `-`, and
  assert the file that lands on disk is byte-identical to what the control plane
  wrote.
- Acceptance: the round trip is proven for an adversarial manifest, and
  [`../reference/zerops-platform.md`](../reference/zerops-platform.md) records
  whether build containers see service variables.

## Touch points

- `packages/installation-zerops/zerops/setups.ts` and the generated root `zerops.yaml`
- `packages/control/src/node/zerops-proxy.ts`
- `packages/proxy/src/generate-config.ts`

<!-- Origin: Zerops skill conformance review, 2026-07-31. -->
