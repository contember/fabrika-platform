---
id: 209
title: File scanning on Cloudflare
blocked-by: []
---

# 209 — File scanning on Cloudflare

**Summary.** A file kind with `scan: true` is refused on Cloudflare: the scan runs `clamscan`, which no Worker or
Durable Object can. P3, size M.

## Problem

`packages/app/src/implement/boot.ts` (`sqliteProblems`) refuses a scanning kind on SQLite, and the checker reports
it. A quarantined file therefore cannot exist on Cloudflare, and an application that needs scanned uploads cannot
run there.

## Approach / acceptance

A scanner reachable from the object: a Cloudflare Container running ClamAV with fresh signatures, called by the
object's scan sweep over a service binding, writing its verdict through the same `fabrika_files` transitions as on
Bun. Witness: the file-scan suite on Lopata with the container stubbed, and once live (207).

## Touch points

`packages/app/src/cloudflare/`, `packages/app/src/implement/boot.ts`, `packages/provider-cloudflare/`.
