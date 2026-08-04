// The cron command — the process-side equivalent of the Worker's `scheduled` handler.
//
// On Cloudflare `triggers.crons` wakes the Worker and calls `scheduled()`. There is no such trigger
// for a plain container, so the platform cron (`zerops.yaml` → `run.crontab`) runs THIS file, which
// calls the same `runIamMaintenance` the Worker's handler calls. Nothing about retention or queries
// lives here.
//
// It is a one-shot process, not a timer inside the server: a timer fires once per container (so it
// multiplies with horizontal scale) and its schedule silently resets on every redeploy. The
// operation is an idempotent DELETE by cutoff, so an overlapping run is harmless regardless.
//
// Run it: `bun src/node/prune.ts`.

import { runIamMaintenance } from '../cron'
import { createRuntime } from './runtime'

async function main(): Promise<void> {
	const runtime = createRuntime()
	try {
		// Maintenance registers the deletes through `waitUntil`; `shutdown()` drains them before the pool
		// closes, so the process exits only once the prune has actually finished.
		runIamMaintenance(runtime.env, runtime.ctx)
	} finally {
		await runtime.shutdown()
	}
	console.info('IAM maintenance complete')
}

if (import.meta.main) {
	main().catch((err: unknown) => {
		console.error('IAM maintenance failed:', err instanceof Error ? err.message : 'unknown error')
		process.exit(1)
	})
}
