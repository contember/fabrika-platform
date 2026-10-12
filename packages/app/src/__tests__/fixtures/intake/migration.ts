// The fixture's only migration, as `db/migrations/` would hold it: two inboxes, each appended to by its form only.
export const migration = `
create table applications (
	name text not null,
	email text not null
);
create table messages (
	email text not null,
	body text not null
);
`
