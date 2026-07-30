# @fabrika/runner-cloudflare

The Cloudflare deploy executor Worker. It owns the per-run `RunnerContainer` Durable Object, relays
container logs and status to R2, and writes terminal run status to the control-plane database. It has
no public route and is called through a service binding.

The Worker↔container protocol lives in `@fabrika/runner-contract`. The plain-Bun process and Docker
image live in `@fabrika/runner-container`. `CloudflareRunnerJob` remains owned and validated by
`@fabrika/provider-cloudflare`.

## Commands

```bash
bun test
bun run oblaka
bun run bootstrap
```

## Invariants

- Never log credentials or secret values.
- Keep the guarded `finishRun` update identical to the control plane's terminal-status write.
- The Worker must stay separate from the control plane so self-deploys cannot reset active runs.
- `RUN_LOGS` and `DB` adopt the control plane's existing R2 and D1 resources.
- `src/index.ts` exports the `VozkaRunner` class as a type only.
- Deploy this Worker out of band. It cannot safely deploy itself through itself.
