// The fixture's only migration, as `db/migrations/` would hold it: an inbox per form, each appended to by its form only.
export const migration = `
create table signups (
	email text not null
);
create table applications (
	email text not null
);
create table notices (
	email text not null
);
`
