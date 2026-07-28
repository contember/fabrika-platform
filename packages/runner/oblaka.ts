// LOCAL-DEV / oblaka entry for vozka-runner's infrastructure. THIN by design: the resource graph
// lives in `fabrika-runner.config.ts` (the single source of truth, dogfooding @fabrika/config), and this
// file just adapts it to oblaka's `define` so the local flows keep working:
//   - `bun run oblaka`        → regenerate wrangler.jsonc (plan/dry)
//   - `bun run oblaka:deploy` → remote provision (off-local, manual)
//
// oblaka's `define` callback only gets `{ env }` (no domain) — vozka-runner has no public domain, so
// `buildRunnerWorker` receives just env. The off-local deploy path (scripts/bootstrap-runner.ts) does
// NOT go through this file — it loads `fabrika-runner.config.ts` directly. Keep this shim and the config
// in lockstep by NEVER re-declaring resources here.

import { define } from 'oblaka-iac'
import { buildRunnerWorker } from './fabrika-runner.config'

export default define(({ env }) => buildRunnerWorker({ env }))
