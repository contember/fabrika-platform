-- The notice a link holder reads: an application row, which no scope holds, shown once published. Its slug is unique:
-- each generated case seeds the row and removes it once it is over, so the next case can seed it again.
create table notices (
	id uuid primary key,
	slug text not null unique,
	body text not null,
	published boolean not null
);
