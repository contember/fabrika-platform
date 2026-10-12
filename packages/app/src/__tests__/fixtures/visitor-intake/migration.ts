// The fixture's only migration, as `db/migrations/` would hold it. A form appends to its inbox; the intake job drains
// both inboxes and keeps each candidate's link delivery in the candidate's own row.
export const migration = `
create table candidates (
	id uuid primary key,
	email text not null unique,
	name text not null,
	verified_at timestamptz,
	link_state text not null default 'due' check (link_state in ('due', 'issued', 'sent')),
	link_id text,
	revoke_link_id text,
	sends integer not null default 0,
	window_started_at timestamptz not null default now(),
	created_by text not null,
	version integer not null
);
create table registrations (
	email text not null,
	name text not null
);
create table resend_requests (
	email text not null
);
`
