// The schema of `src/db/schema.generated.ts` as a migration creates it.
export const migration = `
create table workspaces (
	id text primary key,
	organization_id text not null,
	name text not null,
	unique (id, organization_id)
);
create table notes (
	id uuid primary key,
	workspace_id text not null,
	organization_id text not null,
	title text not null,
	trashed boolean not null,
	created_by text not null,
	version integer not null,
	unique (id, workspace_id, organization_id),
	foreign key (workspace_id, organization_id) references workspaces (id, organization_id)
);
`
