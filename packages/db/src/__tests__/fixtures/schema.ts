// The types and column list are `fabrika db codegen` output for `migration`; codegen.test.ts regenerates and compares.
export { columns, type DB } from './schema.generated'

/**
 * The migration the Postgres suite applies. Every row carries its whole containment chain, and a composite foreign
 * key with ON UPDATE CASCADE keeps it in its container's chain when an ancestor moves.
 */
export const migration = `
create table organizations (id text primary key, name text not null);
create table workspaces (
	id text primary key,
	organization_id text not null references organizations (id),
	name text not null,
	created_by text not null,
	unique (id, organization_id)
);
create table notes (
	id text primary key,
	workspace_id text not null,
	organization_id text not null,
	title text not null,
	body text,
	word_count integer not null default 0,
	internal text,
	created_by text not null,
	version integer not null,
	created_at timestamptz not null default now(),
	unique (id, workspace_id, organization_id),
	foreign key (workspace_id, organization_id) references workspaces (id, organization_id) on update cascade
);
create table note_comments (
	id text primary key,
	note_id text not null,
	workspace_id text not null,
	organization_id text not null,
	body text not null,
	foreign key (note_id, workspace_id, organization_id) references notes (id, workspace_id, organization_id) on update cascade on delete cascade
);
create table note_flags (
	id text primary key,
	note_id text not null,
	workspace_id text not null,
	organization_id text not null,
	reason text not null,
	foreign key (note_id, workspace_id, organization_id) references notes (id, workspace_id, organization_id) on update cascade on delete cascade
);
create table secrets (id text primary key, value text not null);
create table settings (id text primary key, value text not null);
create table countries (code text primary key, name text not null);
`
