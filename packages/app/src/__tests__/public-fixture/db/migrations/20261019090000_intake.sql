create table submissions (
	id uuid primary key,
	name text not null,
	client_ip text,
	user_agent text,
	created_by text not null
);
create table products (
	id uuid primary key,
	name text not null,
	created_by text not null
);
