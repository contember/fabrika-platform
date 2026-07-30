# @fabrika/runner-container

The plain-Bun deploy container. One process accepts one provider-owned job, clones its repository,
installs dependencies, and runs `fabrika-cloudflare-executor deploy`.

The Worker↔container transport types and paths live in `@fabrika/runner-contract`.
`CloudflareRunnerJob` remains owned and validated by `@fabrika/provider-cloudflare`.

## Commands

```bash
bun run serve
bun test
cpu-lease run -n 4 -- bun run docker:build
bun run docker:smoke
```

## Invariants

- Pass credentials, secrets, vars, and state namespace through child environment variables only.
- Never put secret values on argv or in logs.
- Reject a second run while one is active.
- Keep `wrangler` available globally in the image.
- Copy every local workspace dependency into the slim Docker workspace.
