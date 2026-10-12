// The probe app's schema as its migration creates it; `src/db/schema.generated.ts` is `fabrika db codegen` of it.
export const migration = `
create table projects (id text primary key, org_id text not null, title text not null, unique (id, org_id));
create type task_status as enum ('open', 'doing', 'done');
create table tasks (
	id text primary key,
	project_id text not null,
	org_id text not null,
	title text not null,
	status task_status not null default 'open',
	assignee text,
	due_on date,
	closed_at timestamptz,
	overdue boolean not null default false,
	created_by text not null,
	version integer not null,
	unique (id, project_id, org_id),
	foreign key (project_id, org_id) references projects (id, org_id) on update cascade
);
`
