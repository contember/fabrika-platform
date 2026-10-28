// A kit application on Cloudflare over Postgres (`cloudflare-postgres-*.test.ts`): one dimension table, a write that
// kicks a job, a write that puts a file, a read, and the job, served by the Worker over Hyperdrive.

import { app } from './src/app-kit'
import { notes, tally } from './src/notes/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { notes }),
	health: c.health('/healthz'),
	files: { attachments: c.files({ maxBytes: 4096, types: ['text/plain'] }) },
	jobs: { tally },
}))
