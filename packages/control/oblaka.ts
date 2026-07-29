// LOCAL-DEV / oblaka entry for fabrika's infrastructure. THIN by design: the resource graph itself
// lives in `fabrika.config.ts` (the single source of truth), and this file
// just adapts it to oblaka's `define` so the local flows keep working unchanged:
//   - `bun run oblaka`        → regenerate wrangler.jsonc (plan/dry)
//   - `bun run oblaka:deploy` → remote provision (off-local, manual)
//   - `wrangler d1 migrations apply DB --local` → apply migrations against the local D1
//
// oblaka's `define` callback only gets `{ env }` (no domain) — fabrika's domain is a deploy-time var on
// the provider deploy path; locally there is no public domain, so `buildVozkaWorker` receives just env.
//
// The off-local provider self-deploy path does NOT go through this file — it loads
// `fabrika.config.ts` directly (CLI / scripts/bootstrap.ts). Keep this shim and fabrika.config.ts in
// lockstep by NEVER re-declaring resources here.

import { define } from 'oblaka-iac'
import { buildVozkaWorker } from './fabrika.config'

export default define(({ env }) => buildVozkaWorker({ env }))
