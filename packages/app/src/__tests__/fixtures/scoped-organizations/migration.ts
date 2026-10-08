// The fixture's only migration, as `db/migrations/` would hold it. Every row carries its whole containment chain;
// the composite foreign key with ON UPDATE CASCADE moves a workspace's notes with it. No table owns `organization`:
// it is a scope value IAM grants in.
export const migration = `
create table workspaces (
	id text primary key,
	organization_id text not null,
	unique (id, organization_id)
);
create table notes (
	id uuid primary key,
	workspace_id text not null,
	organization_id text not null,
	title text not null,
	foreign key (workspace_id, organization_id) references workspaces (id, organization_id) on update cascade
);
`
