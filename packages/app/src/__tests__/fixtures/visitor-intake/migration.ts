// The fixture's migrations, as `db/migrations/` would hold them. A form appends to its inbox; the intake job drains
// both inboxes and keeps each candidate's link delivery in the candidate's own row; a candidate owns its attachments.
// An inbox row and a delivery each count their failed attempts and keep the step that failed last; one that failed
// MAX_ATTEMPTS times is dead (a registration left in its inbox, a delivery 'failed') until an operator acts. A link
// waiting to be e-mailed keeps its URL sealed (link_seal), never in plain text, so a retry sends the same link.
import { fileTableSql } from '@fabrika/db'

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
	id uuid not null default gen_random_uuid(),
	email text not null,
	name text not null,
	received_at timestamptz not null default now(),
	attempts integer not null default 0,
	last_failure text
);
create table resend_requests (
	id uuid not null default gen_random_uuid(),
	email text not null,
	received_at timestamptz not null default now()
);
${fileTableSql('attachments', { table: 'candidates', key: { column: 'id', type: 'uuid' }, chain: [] })}
`
