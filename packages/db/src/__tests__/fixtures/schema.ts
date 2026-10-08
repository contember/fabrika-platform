import type { Generated } from 'kysely'

// Stands in for kysely-codegen output and the column list generated next to it.

export interface Organizations {
	id: string
	name: string
}

export interface Workspaces {
	id: string
	organization_id: string
	name: string
	created_by: string
}

export interface Notes {
	id: string
	workspace_id: string
	organization_id: string
	title: string
	body: string | null
	word_count: Generated<number>
	internal: string | null
	created_by: string
	version: number
	created_at: Generated<Date>
}

export interface NoteComments {
	id: string
	note_id: string
	workspace_id: string
	organization_id: string
	body: string
}

export interface NoteFlags {
	id: string
	note_id: string
	workspace_id: string
	organization_id: string
	reason: string
}

export interface Secrets {
	id: string
	value: string
}

export interface Countries {
	code: string
	name: string
}

export interface ContactMessages {
	id: string
	email: string
	body: string
}

export interface DB {
	organizations: Organizations
	workspaces: Workspaces
	notes: Notes
	note_comments: NoteComments
	note_flags: NoteFlags
	secrets: Secrets
	countries: Countries
	contact_messages: ContactMessages
}

export const columns = {
	organizations: ['id', 'name'],
	workspaces: ['id', 'organization_id', 'name', 'created_by'],
	notes: ['id', 'workspace_id', 'organization_id', 'title', 'body', 'word_count', 'internal', 'created_by', 'version', 'created_at'],
	note_comments: ['id', 'note_id', 'workspace_id', 'organization_id', 'body'],
	note_flags: ['id', 'note_id', 'workspace_id', 'organization_id', 'reason'],
	secrets: ['id', 'value'],
	countries: ['code', 'name'],
	contact_messages: ['id', 'email', 'body'],
} as const

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
create table countries (code text primary key, name text not null);
create table contact_messages (id text primary key, email text not null, body text not null);
`
