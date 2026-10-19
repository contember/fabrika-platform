create table unsubscribes (
	id uuid primary key,
	email text not null,
	campaign text not null,
	created_by text not null,
	unique (email, campaign)
);
create table bookings (
	id uuid primary key,
	name text not null,
	slot text not null,
	version integer not null default 1,
	created_by text not null
);
create table clicks (
	id uuid primary key,
	campaign text not null,
	created_by text not null
);
