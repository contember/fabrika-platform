create table orgs (
	id text primary key,
	name text not null
);

create table companies (
	id text primary key,
	org_id text not null references orgs (id),
	name text not null,
	unique (id, org_id)
);

create table deals (
	id uuid primary key,
	company_id text not null,
	org_id text not null,
	title text not null,
	owner text,
	owner_label text,
	created_by text not null,
	version integer not null,
	foreign key (company_id, org_id) references companies (id, org_id)
);
