// A kit application on Cloudflare (`cloudflare-runtime.test.ts`): one dimension table on SQLite, a write and a read,
// three jobs and a file kind, served by the environment's Durable Object.

import { app } from './src/app-kit'
import { halfPast, nightly, notes, putThenFail } from './src/notes/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { notes }),
	health: c.health('/healthz'),
	files: { attachments: c.files({ maxBytes: 4096, types: ['text/plain'] }) },
	jobs: { nightly, halfPast, putThenFail },
}))
