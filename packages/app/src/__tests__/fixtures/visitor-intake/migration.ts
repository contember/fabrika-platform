// The fixture's migrations, as `db/migrations/` would hold them. The public procedures write a registration or a
// resend request; the intake job claims the registrations as a queue, drains the resend requests, and keeps each
// candidate's link delivery in the candidate's own row; a candidate's files are rows of candidate_files. A
// registration counts its claims and keeps the step that failed last; one claimed MAX_ATTEMPTS times stays, no longer
// due, for an operator. A delivery counts its failed attempts the same way and is 'failed' after MAX_ATTEMPTS. A link
// waiting to be e-mailed keeps its URL sealed (link_seal), never in plain text, so a retry sends the same link.

export const migration = `
create table candidates (
	id uuid primary key,
	email text not null unique,
	name text not null check (char_length(name) <= 200),
	verified_at timestamptz,
	link_state text not null default 'due' check (link_state in ('due', 'issued', 'sent', 'failed')),
	link_id text,
	link_seal text,
	revoke_link_id text,
	sends integer not null default 0,
	window_started_at timestamptz not null default now(),
	attempts integer not null default 0,
	last_failure text,
	created_by text not null,
	version integer not null
);
create table registrations (
	id uuid primary key,
	email text not null,
	name text not null,
	attempts integer not null default 0,
	due_at timestamptz default now(),
	last_failure text,
	version integer not null
);
create table resend_requests (
	id uuid primary key,
	email text not null,
	received_at timestamptz not null default now()
);
create table candidate_files (
	id uuid primary key,
	candidate_id uuid not null references candidates (id),
	file uuid not null references fabrika_files (id)
);
create index candidate_files_file on candidate_files (file);
`
