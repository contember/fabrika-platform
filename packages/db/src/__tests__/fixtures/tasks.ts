// A task tracker (org → project → task), the shape two fresh-agent probes built: a column only its own action writes
// (`assignee`, by `tasks.assign`), a column only one action reads (`cost`, by `tasks.assign` too), a calendar day
// (`due_on`) and a point in time (`closed_at`). The org is a scope only IAM knows, so no table owns it.

import { defineTables } from '../../policy'
import { columns } from './tasks.generated'

export { columns, type DB } from './tasks.generated'

export const vocabulary = {
	app: 'tasks',
	dimensions: { org: {}, project: { in: 'org' }, task: { in: 'project' } },
	actions: {
		'tasks.read': 'Read projects and tasks',
		'tasks.write': 'Create and edit projects and tasks',
		'tasks.assign': 'Assign tasks, see what they cost and pin comments',
	},
	roles: {},
} as const

export const tables = defineTables(vocabulary, columns)({
	projects: {
		scope: { dimension: 'project' },
		actions: { read: 'tasks.read', insert: 'tasks.write' },
		insert: ['title'],
	},
	tasks: {
		scope: { dimension: 'task' },
		actions: { read: 'tasks.read', insert: 'tasks.write', update: 'tasks.write' },
		insert: ['title', 'status', 'due_on'],
		update: ['title', 'status', 'due_on', 'closed_at', 'overdue'],
		version: 'version',
		createdBy: 'created_by',
		columns: { assignee: { write: 'tasks.assign' }, cost: { read: 'tasks.assign' } },
	},
	task_comments: {
		scope: { child: 'tasks' },
		actions: { read: 'tasks.read', insert: 'tasks.write', update: 'tasks.write' },
		insert: ['body'],
		update: ['body'],
		columns: { pinned: { write: 'tasks.assign' } },
	},
})

/** The migration the Postgres suites apply; codegen.test.ts regenerates `tasks.generated.ts` from it. */
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
	cost integer,
	created_by text not null,
	version integer not null,
	unique (id, project_id, org_id),
	foreign key (project_id, org_id) references projects (id, org_id) on update cascade
);
create table task_comments (
	id text primary key,
	task_id text not null,
	project_id text not null,
	org_id text not null,
	body text not null,
	pinned boolean not null default false,
	foreign key (task_id, project_id, org_id) references tasks (id, project_id, org_id) on update cascade on delete cascade
);
`
