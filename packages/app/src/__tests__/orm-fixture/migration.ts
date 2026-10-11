// The kit fixture's schema (`kit-fixture/src/db/schema.generated.ts`) as a migration would create it.
export const migration = `
create table orgs (id text primary key, name text not null, created_by text not null, version integer not null);
create table companies (
	id text primary key,
	org_id text not null references orgs (id),
	name text not null,
	created_by text not null,
	version integer not null,
	unique (id, org_id)
);
create type deal_stage as enum ('lead', 'proposal', 'won', 'lost');
create table deals (
	id text primary key,
	company_id text not null,
	org_id text not null,
	title text not null,
	stage deal_stage not null,
	margin integer,
	created_by text not null,
	version integer not null,
	unique (id, company_id, org_id),
	foreign key (company_id, org_id) references companies (id, org_id) on update cascade
);
create table deal_activities (
	id text primary key,
	deal_id text not null,
	company_id text not null,
	org_id text not null,
	body text not null,
	created_by text not null,
	foreign key (deal_id, company_id, org_id) references deals (id, company_id, org_id) on update cascade on delete cascade
);
create table countries (code text primary key, name text not null, note text);
`
