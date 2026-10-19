// The fixture's only migration, as `db/migrations/` would hold it: a table per public procedure, each written by it only.
export const migration = `
create table signups (
	id uuid primary key,
	email text not null
);
create table applications (
	id uuid primary key,
	email text not null
);
create table notices (
	id uuid primary key,
	email text not null
);
`
