---
id: wrangler
kind: technology
title: wrangler (Cloudflare CLI)
slot: null
provides: [cf-cli, d1-cli, deploy]
requires: [cloudflare]
recommends: [oblaka]
conflicts: []
npm: ["wrangler@^4"]
status: stable
sources:
  - where: "developers.cloudflare.com/workers/wrangler (d1 migrations/execute, dev, deploy)"
    read: "The d1 subcommands (migrations apply / execute --local --file) and deploy."
---

# wrangler

## What it is

Cloudflare's official CLI: local D1 lifecycle (`wrangler d1 migrations apply DB
--local`, `wrangler d1 execute DB --local --file …`), `wrangler dev` (workerd), and
`wrangler deploy`. Used directly on the real-CF path and internally by Vozka for
remote D1 migrations, Worker deploy and secret sync; the local-first path uses
the `lopata` CLI instead.

## When & why to use

- The real-CF dev/deploy path (alongside `cloudflare-vite-plugin`).
- Local D1 migrations/seeds when not using `lopata d1`.
- A Vozka-managed app still includes a compatible wrangler dependency because
  the deploy engine invokes its binary against the materialized config.

## Impacts & gotchas

- It **operates on the generated `wrangler.jsonc`** (from `oblaka`) — don't hand-edit that file.
- D1 commands need `--local` for local dev; production deploy needs a CF account/token.

## Relationships — why

- **requires `cloudflare`**; **recommends `oblaka`** (it reads the generated config).
