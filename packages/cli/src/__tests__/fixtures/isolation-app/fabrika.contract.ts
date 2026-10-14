// The application the generated tests are written for: a top-level dimension table, two contained ones, a child table
// and a reference table that a required and a nullable foreign key outside the chain name, with a column read policy, a
// version column and text CHECKs; an endpoint that addresses a child row by its id; endpoints of every access form, for a person
// and for a machine caller; and the endpoints that write through IAM: one that creates an organization, one that
// invites the members of a workspace, one that removes one and one that cancels an invitation by id, one that issues a
// link of the share mount and one that revokes a link by id. A child table's writes need the workspace's members.manage.

import { app } from './src/app-kit'
import { notes, ops, organizations, shared, workspaces } from './src/notes/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { organizations, workspaces, notes }),
	ops: c.rpc('/ops', ops),
	shared,
	health: c.health('/healthz'),
}))
