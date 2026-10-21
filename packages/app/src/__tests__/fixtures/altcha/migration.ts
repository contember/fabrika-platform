// The fixture's only migration, as `db/migrations/` would hold it: a table per public procedure, each written by it only.
export const migration = `
create table applications (
	id uuid primary key,
	name text not null,
	email text not null
);
create table messages (
	id uuid primary key,
	email text not null,
	body text not null
);
`
