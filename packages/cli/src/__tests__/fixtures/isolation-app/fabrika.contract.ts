// The application the generated tests are written for: a top-level dimension table, two contained ones, a child table
// and a reference table, with a column read policy and a version column; endpoints of every access form, for a person
// and for a machine caller.

import { app } from './src/app-kit'
import { notes, ops, organizations, workspaces } from './src/notes/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { organizations, workspaces, notes }),
	ops: c.rpc('/ops', ops),
	health: c.health('/healthz'),
}))
