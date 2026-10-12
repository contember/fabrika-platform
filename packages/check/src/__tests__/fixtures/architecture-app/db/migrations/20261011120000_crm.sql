create table companies (id uuid primary key, org_id text not null, name text not null, version int not null default 1, unique (id, org_id));
create type deal_stage as enum ('lead', 'proposal', 'won', 'lost');
create table deals (
	id uuid primary key,
	company_id uuid not null,
	org_id text not null,
	title text not null,
	stage deal_stage not null,
	version int not null default 1,
	foreign key (company_id, org_id) references companies (id, org_id) on update cascade
);
