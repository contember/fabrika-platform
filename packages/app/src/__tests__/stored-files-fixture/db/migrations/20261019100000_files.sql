create table deals (
	id text primary key,
	org_id text not null,
	name text not null,
	unique (id, org_id)
);
create table deal_attachments (
	id text primary key,
	deal_id text not null,
	org_id text not null,
	file uuid not null references fabrika_files (id),
	name text not null,
	foreign key (deal_id, org_id) references deals (id, org_id)
);
create index deal_attachments_file on deal_attachments (file);
create table products (
	id text primary key,
	name text not null,
	image uuid references fabrika_files (id),
	version integer not null
);
create index products_image on products (image);
create table submissions (
	id text primary key,
	name text not null,
	photo uuid references fabrika_files (id)
);
create index submissions_photo on submissions (photo);
