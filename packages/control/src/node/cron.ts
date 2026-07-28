// The cron command — the process-side equivalent of the Worker's `scheduled` handler.
//
// On Cloudflare `triggers.crons` wakes the Worker and calls `scheduled()`. There is no such trigger for
// a plain container, so the platform cron (`zerops.yaml` → `run.crontab`) runs THIS file, which calls
// the same `runMaintenance` the Worker's handler calls. Nothing about the poll or the sweep lives here.
//
// It is a one-shot process, not a timer inside the server: a timer fires once per container (so it
// multiplies with horizontal scale) and its schedule silently resets on every redeploy. `allContainers:
// false` in the crontab entry keeps a horizontally-scaled service polling once.
//
// Run it: `bun src/node/cron.ts`.

import { runMaintenance } from '../cron'
import { createRuntime } from './runtime'

async function main(): Promise<void> {
	const runtime = createRuntime()
	try {
		await runMaintenance(runtime.env)
	} finally {
		await runtime.shutdown()
	}
}

if (import.meta.main) {
	// Never log the error object: it can carry a feed URL or a connection string.
	main().catch((err: unknown) => {
		console.error('maintenance failed:', err instanceof Error ? err.message : 'unknown error')
		process.exit(1)
	})
}
