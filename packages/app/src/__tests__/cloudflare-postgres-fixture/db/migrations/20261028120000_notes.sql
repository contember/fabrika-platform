-- A note lies in a workspace, which has no table of its own.
create table notes (
	id uuid primary key,
	workspace_id text not null,
	title text not null,
	created_by text not null,
	version integer not null,
	unique (id, workspace_id)
);
