// The fixture's only migration, as `db/migrations/` would hold it. No table owns `workspace`: a workspace is a scope
// value IAM creates. The contact inbox is appended to by its form only.
export const migration = `
create table notes (
	id uuid primary key,
	workspace_id text not null,
	title text not null,
	created_by text not null,
	version integer not null
);
create table contact_messages (
	email text not null,
	body text not null
);
`
