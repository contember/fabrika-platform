// The fixture's only migration, as `db/migrations/` would hold it: the outbox the mutations fill and the job drains.
export const migration = `
create table outbox (
	id uuid primary key,
	body text not null
);
`
