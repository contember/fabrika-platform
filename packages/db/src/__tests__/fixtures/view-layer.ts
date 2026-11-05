// Views read as read-only tables (ADR-0072): one migration both dialects run, the column list codegen renders for it
// (the SQLite suite renders it again and compares), and the policies. A per-parent summary keyed by its parent, a child
// view keyed by its own id with a column of its own read action, a reference view, and a view without a policy.

import type { TypedColumnList } from '@fabrika/db'
import type { ColumnType } from 'kysely'
import { defineTables } from '../../policy'

export const viewMigration = `
create table organizations (id text not null primary key, name text not null);
create table projects (
	id text not null primary key,
	organization_id text not null references organizations (id),
	name text not null,
	unique (id, organization_id)
);
create table events (
	id text not null primary key,
	project_id text not null,
	organization_id text not null,
	at timestamp not null,
	note text,
	foreign key (project_id, organization_id) references projects (id, organization_id)
);
create view project_summaries as
	select p.id as project_id, p.organization_id, p.name, cast(count(e.id) as integer) as events
	from projects p left join events e on e.project_id = p.id
	group by p.id, p.organization_id, p.name;
create view event_notes as select e.id, e.project_id, e.organization_id, e.at, e.note from events e;
create view organization_names as select id, name from organizations;
create view project_names as select id, name from projects;
`

export interface EventNotesView {
	id: string | null
	project_id: string | null
	organization_id: string | null
	at: ColumnType<Date | null, Date | string | null, Date | string | null>
	note: string | null
}

export interface EventsTable {
	id: string
	project_id: string
	organization_id: string
	at: ColumnType<Date, Date | string, Date | string>
	note: string | null
}

export interface OrganizationNamesView {
	id: string | null
	name: string | null
}

export interface OrganizationsTable {
	id: string
	name: string
}

export interface ProjectNamesView {
	id: string | null
	name: string | null
}

export interface ProjectSummariesView {
	project_id: string | null
	organization_id: string | null
	name: string | null
	events: number | null
}

export interface ProjectsTable {
	id: string
	organization_id: string
	name: string
}

export interface DB {
	event_notes: EventNotesView
	events: EventsTable
	organization_names: OrganizationNamesView
	organizations: OrganizationsTable
	project_names: ProjectNamesView
	project_summaries: ProjectSummariesView
	projects: ProjectsTable
}

export type Views =
	| 'event_notes'
	| 'organization_names'
	| 'project_names'
	| 'project_summaries'

export const viewColumns: TypedColumnList<DB, Views> = {
	'event_notes': {
		columns: [
			'id',
			'project_id',
			'organization_id',
			'at',
			'note',
		],
		foreignKeys: [],
		timestamps: ['at'],
		view: true,
	},
	'events': {
		columns: [
			'id',
			'project_id',
			'organization_id',
			'at',
			'note',
		],
		foreignKeys: [
			{
				columns: ['project_id', 'organization_id'],
				table: 'projects',
				references: ['id', 'organization_id'],
			},
		],
		timestamps: ['at'],
	},
	'organization_names': {
		columns: [
			'id',
			'name',
		],
		foreignKeys: [],
		view: true,
	},
	'organizations': {
		columns: [
			'id',
			'name',
		],
		foreignKeys: [],
	},
	'project_names': {
		columns: [
			'id',
			'name',
		],
		foreignKeys: [],
		view: true,
	},
	'project_summaries': {
		columns: [
			'project_id',
			'organization_id',
			'name',
			'events',
		],
		foreignKeys: [],
		view: true,
	},
	'projects': {
		columns: [
			'id',
			'organization_id',
			'name',
		],
		foreignKeys: [
			{
				columns: ['organization_id'],
				table: 'organizations',
				references: ['id'],
			},
		],
	},
}

export const viewVocabulary = {
	app: 'projects',
	dimensions: { organization: {}, project: { in: 'organization' } },
	actions: {
		'projects.read': 'Read projects',
		'projects.write': 'Write projects',
		'notes.read': 'Read the notes of events',
	},
	roles: {},
} as const

export const viewTables = defineTables(viewVocabulary, viewColumns)({
	organizations: {
		scope: { dimension: 'organization' },
		actions: { read: 'projects.read' },
	},
	projects: {
		scope: { dimension: 'project' },
		actions: { read: 'projects.read', insert: 'projects.write' },
		insert: ['name'],
	},
	events: {
		scope: { child: 'projects' },
		actions: { read: 'projects.read', insert: 'projects.write' },
		insert: ['at', 'note'],
	},
	project_summaries: {
		scope: { child: 'projects', key: 'project_id' },
		actions: { read: 'projects.read' },
	},
	event_notes: {
		scope: { child: 'projects' },
		actions: { read: ['projects.read', 'notes.read'] },
		columns: { note: { read: 'notes.read' } },
	},
	organization_names: {
		scope: { reference: 'every site shows the names of the organizations' },
		actions: { read: 'projects.read' },
	},
})
