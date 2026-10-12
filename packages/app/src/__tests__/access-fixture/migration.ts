// The schema of `src/db/schema.generated.ts` as a migration creates it.
export const migration = `
create table notes (
	id uuid primary key,
	workspace_id text not null,
	title text not null,
	trashed boolean not null,
	created_by text not null,
	version integer not null,
	unique (id, workspace_id)
);
`
