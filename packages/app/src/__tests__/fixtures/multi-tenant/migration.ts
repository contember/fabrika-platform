// The fixture's only migration, as `db/migrations/` would hold it. No table owns `workspace`: a workspace is a scope
// value IAM creates.
export const migration = `
create table notes (
	id uuid primary key,
	workspace_id text not null,
	title text not null,
	created_by text not null,
	version integer not null
);
`
