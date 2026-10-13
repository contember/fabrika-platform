create table candidates (
	id uuid primary key,
	name text not null,
	status text not null default 'new' check (status in ('new', 'hired')),
	created_by text not null,
	version integer not null
);
create table positions (
	id uuid primary key,
	title text not null,
	active boolean not null default true,
	created_by text not null,
	version integer not null
);
create table exports (
	id uuid primary key,
	rows integer not null,
	created_by text not null,
	created_at timestamptz not null default now()
);
