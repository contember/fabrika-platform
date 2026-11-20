-- Every row carries its whole containment chain; a composite foreign key with ON UPDATE CASCADE keeps it current.
-- A country is a code list; an organization names one, a note may.
create table countries (
	code text primary key,
	name text not null
);

create table organizations (
	id uuid primary key,
	name text not null,
	country_code text not null references countries (code)
);

create table workspaces (
	id text primary key,
	organization_id uuid not null references organizations (id),
	name text not null,
	unique (id, organization_id)
);

create table notes (
	id text primary key,
	workspace_id text not null,
	organization_id uuid not null,
	title text not null,
	body text,
	internal text,
	pinned boolean not null,
	country_code text references countries (code),
	tone text check (tone in ('calm', 'urgent')),
	created_by text not null,
	version integer not null,
	unique (id, workspace_id, organization_id),
	foreign key (workspace_id, organization_id) references workspaces (id, organization_id) on update cascade
);

create table note_comments (
	id text primary key,
	note_id text not null,
	workspace_id text not null,
	organization_id uuid not null,
	body text not null,
	foreign key (note_id, workspace_id, organization_id) references notes (id, workspace_id, organization_id) on update cascade on delete cascade
);

-- The workspace's member log: written by a holder of the workspace's members.manage.
create table workspace_events (
	id text primary key,
	workspace_id text not null,
	organization_id uuid not null,
	summary text not null,
	kind text not null check (kind in ('invited', 'removed')),
	foreign key (workspace_id, organization_id) references workspaces (id, organization_id) on update cascade on delete cascade
);
