create table reasons (
	id uuid primary key,
	label text not null,
	active boolean not null default true,
	created_by text not null,
	version integer not null
);
alter table candidates add column reason_id uuid;
