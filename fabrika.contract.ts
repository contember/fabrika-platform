// The example application's whole access surface: who may call what. The proxy enforces it from the endpoint table
// the deployer compiles out of this file; each endpoint carries its handler (`src/access/endpoints.ts`,
// `src/notes/endpoints.ts`).

import { access } from './src/access/endpoints'
import { bulk } from './src/bulk/endpoints'
import { app } from './src/app-kit'
import { notes, review } from './src/notes/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', access),
	notes: c.rpc('/notes', notes),
	bulk: c.rpc('/bulk', bulk),
	site: c.spa('/', { dir: 'dist/web', access: { member: true } }),
	health: c.health('/healthz'),
	files: { attachments: c.files({ maxBytes: 41943040, types: ['text/plain', 'image/png'] }) },
	jobs: { review },
}))
