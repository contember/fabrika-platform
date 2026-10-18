// The fixture's migrations, as `db/migrations/` would hold them. Each form's inbox has a column per input field and one
// per file field, which receives the id of the file the submission carried; a candidate owns its photos.
import { fileTableSql } from '@fabrika/db'

export const migration = `
create table candidates (
	id uuid primary key,
	email text not null unique,
	name text not null,
	created_by text not null,
	version integer not null
);
create table registrations (
	id uuid not null default gen_random_uuid(),
	email text not null,
	name text not null,
	photo uuid,
	received_at timestamptz not null default now()
);
create table applications (
	id uuid not null default gen_random_uuid(),
	email text not null,
	portrait uuid not null,
	received_at timestamptz not null default now()
);
${fileTableSql('photos', { table: 'candidates', key: { column: 'id', type: 'uuid' }, chain: [] })}
`
