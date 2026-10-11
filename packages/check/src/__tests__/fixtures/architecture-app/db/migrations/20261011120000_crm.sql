create table companies (id uuid primary key, org_id text not null, name text not null, version int not null default 1);
create table deals (id uuid primary key, company_id uuid not null references companies (id), title text not null, stage text not null, version int not null default 1);
