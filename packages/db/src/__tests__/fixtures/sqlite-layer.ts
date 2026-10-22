// A small application on SQLite (ADR-0065): its migration, the column list `generateSqliteSchema` renders for it (the
// SQLite suite renders it again and compares), and its policies. A dimension table with a timestamp, a boolean, a day
// and a nullable integer, and a child table under it.

import type { TypedColumnList } from '@fabrika/db'
import type { ColumnType, Generated } from 'kysely'
import { defineTables } from '../../policy'

export const sqliteMigration = `
create table organizations (id text not null primary key, name text not null);
create table projects (
	id text not null primary key,
	organization_id text not null references organizations (id),
	name text not null,
	archived boolean not null default 0,
	due_on date,
	starts_at timestamp,
	rank integer,
	version integer not null,
	created_at timestamp not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	unique (id, organization_id)
);
create table events (
	id text not null primary key,
	project_id text not null,
	organization_id text not null,
	at timestamp not null,
	urgent boolean not null,
	note text,
	foreign key (project_id, organization_id) references projects (id, organization_id) on delete cascade
);
`

export interface EventsTable {
	id: string
	project_id: string
	organization_id: string
	at: ColumnType<Date, Date | string, Date | string>
	urgent: boolean
	note: string | null
}

export interface OrganizationsTable {
	id: string
	name: string
}

export interface ProjectsTable {
	id: string
	organization_id: string
	name: string
	archived: Generated<boolean>
	due_on: string | null
	starts_at: ColumnType<Date | null, Date | string | null, Date | string | null>
	rank: number | null
	version: number
	created_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export interface DB {
	events: EventsTable
	organizations: OrganizationsTable
	projects: ProjectsTable
}

export const sqliteColumns: TypedColumnList<DB> = {
	'events': {
		columns: [
			'id',
			'project_id',
			'organization_id',
			'at',
			'urgent',
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
		booleans: ['urgent'],
	},
	'organizations': {
		columns: [
			'id',
			'name',
		],
		foreignKeys: [],
	},
	'projects': {
		columns: [
			'id',
			'organization_id',
			'name',
			'archived',
			'due_on',
			'starts_at',
			'rank',
			'version',
			'created_at',
		],
		foreignKeys: [
			{
				columns: ['organization_id'],
				table: 'organizations',
				references: ['id'],
			},
		],
		dates: ['due_on'],
		timestamps: ['starts_at', 'created_at'],
		booleans: ['archived'],
	},
}

export const sqliteVocabulary = {
	app: 'projects',
	dimensions: { organization: {}, project: { in: 'organization' } },
	actions: {
		'projects.read': 'Read projects',
		'projects.write': 'Write projects',
		'organizations.create': 'Start an organization',
	},
	roles: {},
} as const

export const sqliteTables = defineTables(sqliteVocabulary, sqliteColumns)({
	organizations: {
		scope: { dimension: 'organization' },
		actions: { read: 'projects.read', insert: 'organizations.create' },
		insert: ['name'],
	},
	projects: {
		scope: { dimension: 'project' },
		actions: { read: 'projects.read', insert: 'projects.write', update: 'projects.write', delete: 'projects.write' },
		insert: ['name', 'archived', 'due_on', 'starts_at', 'rank'],
		update: ['name', 'archived', 'due_on', 'starts_at', 'rank'],
		version: 'version',
	},
	events: {
		scope: { child: 'projects' },
		actions: { read: 'projects.read', insert: 'projects.write', update: 'projects.write' },
		insert: ['at', 'urgent', 'note'],
		update: ['at', 'urgent', 'note'],
	},
})
