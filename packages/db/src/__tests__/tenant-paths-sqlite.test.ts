// A condition's path into a scoped table outside the row's containment, on SQLite: it is followed only along a foreign
// key that also holds every ancestor the two tables share, so the row it tests lies in the row's own tenant.

import type { TypedColumnList } from '@fabrika/db'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ColumnType } from 'kysely'
import type { ConditionPolicy } from '../conditions'
import { QueryRefusedError } from '../errors'
import { bindScopedDatabaseProvisionally, type DataAccess, dataAccessOf, type DataSite } from '../framework'
import { defineTables, type ForeignKey } from '../policy'
import { openSqlite } from '../sqlite'
import { type BunSqliteStorage, bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import { TestAuthority } from './fixtures/authority'

const migration = `
create table orgs (id text not null primary key, version integer not null);
create table projects (
	id text not null primary key,
	org_id text not null references orgs (id),
	label_id text,
	version integer not null,
	unique (id, org_id),
	foreign key (label_id) references labels (id),
	foreign key (label_id, org_id) references labels (id, org_id)
);
create table labels (
	id text not null primary key,
	org_id text not null references orgs (id),
	slug text not null unique,
	public boolean not null,
	version integer not null,
	unique (id, org_id)
);
create table vendors (id text not null primary key, trusted boolean not null, version integer not null);
create table tasks (
	id text not null primary key,
	project_id text not null,
	org_id text not null,
	label_id text not null,
	vendor_id text,
	foreign key (project_id, org_id) references projects (id, org_id),
	foreign key (label_id) references labels (id),
	foreign key (label_id, org_id) references labels (id, org_id),
	foreign key (vendor_id) references vendors (id)
);
`

interface DB {
	orgs: { id: string; version: number }
	projects: { id: string; org_id: string; label_id: string | null; version: number }
	labels: { id: string; org_id: string; slug: string; public: ColumnType<boolean, boolean, boolean>; version: number }
	vendors: { id: string; trusted: ColumnType<boolean, boolean, boolean>; version: number }
	tasks: { id: string; project_id: string; org_id: string; label_id: string; vendor_id: string | null }
}

type TaskKey = ForeignKey<keyof DB['tasks'] & string, keyof DB & string>

const labelKey: TaskKey = { columns: ['label_id'], table: 'labels', references: ['id'] }
const tenantKey: TaskKey = { columns: ['label_id', 'org_id'], table: 'labels', references: ['id', 'org_id'] }

function columnsWith(taskKeys: readonly TaskKey[]): TypedColumnList<DB> {
	return {
		orgs: { columns: ['id', 'version'], foreignKeys: [] },
		projects: {
			columns: ['id', 'org_id', 'label_id', 'version'],
			foreignKeys: [
				{ columns: ['org_id'], table: 'orgs', references: ['id'] },
				{ columns: ['label_id'], table: 'labels', references: ['id'] },
				{ columns: ['label_id', 'org_id'], table: 'labels', references: ['id', 'org_id'] },
			],
		},
		labels: {
			columns: ['id', 'org_id', 'slug', 'public', 'version'],
			foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }],
			booleans: ['public'],
		},
		vendors: { columns: ['id', 'trusted', 'version'], foreignKeys: [], booleans: ['trusted'] },
		tasks: {
			columns: ['id', 'project_id', 'org_id', 'label_id', 'vendor_id'],
			foreignKeys: [
				{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] },
				{ columns: ['vendor_id'], table: 'vendors', references: ['id'] },
				...taskKeys,
			],
		},
	}
}

const vocabulary = {
	app: 'paths',
	dimensions: { org: {}, project: { in: 'org' }, label: { in: 'org' }, vendor: {} },
	actions: { 'tasks.read': 'Read tasks', 'labels.read': 'Read labels' },
	roles: {},
} as const

function tablesWith(
	when: ConditionPolicy<keyof DB['tasks'] & string>,
	taskKeys: readonly TaskKey[] = [labelKey, tenantKey],
	projectWhen: ConditionPolicy<keyof DB['projects'] & string> = { label_id: { isNull: false } },
) {
	return defineTables(vocabulary, columnsWith(taskKeys))({
		orgs: { scope: { dimension: 'org' }, actions: { read: 'labels.read' }, version: 'version' },
		projects: { scope: { dimension: 'project' }, actions: { read: 'tasks.read' }, version: 'version', when: { 'tasks.read': projectWhen } },
		labels: { scope: { dimension: 'label' }, actions: { read: 'labels.read' }, version: 'version' },
		vendors: { scope: { dimension: 'vendor' }, actions: { read: 'labels.read' }, version: 'version' },
		tasks: { scope: { child: 'projects' }, actions: { read: 'tasks.read' }, when: { 'tasks.read': when } },
	})
}

const alice = new TestAuthority('user:alice')
let storage: BunSqliteStorage

beforeEach(() => {
	storage = bunSqliteStorage()
	storage.sql.exec(migration)
	storage.sql.exec(`
		insert into orgs (id, version) values ('o1', 1);
		insert into labels (id, org_id, slug, public, version) values ('l1', 'o1', 'one', 1, 1), ('l2', 'o1', 'two', 0, 1);
		insert into projects (id, org_id, label_id, version) values ('p1', 'o1', 'l1', 1), ('p2', 'o1', 'l2', 1);
		insert into tasks (id, project_id, org_id, label_id) values ('k1', 'p1', 'o1', 'l1'), ('k2', 'p1', 'o1', 'l2');
	`)
})

async function listed(
	data: DataAccess,
	table = 'tasks',
	dimension: 'org' | 'project' = 'project',
	values: readonly string[] = ['p1'],
): Promise<string[]> {
	const transaction = data.invocation(true)
	const site: DataSite = {
		kind: 'query',
		unscoped: {},
		principal: 'user:alice',
		check() {
			if (transaction.ended) throw new QueryRefusedError('ended', 'this invocation has ended')
		},
		session: () => transaction.session(),
	}
	const within: unknown = Reflect.get(data.handles(site).within(alice.within(dimension, 'tasks.read', values)), table)
	const list: unknown = typeof within === 'object' && within !== null ? Reflect.get(within, 'list') : undefined
	if (typeof list !== 'function') throw new TypeError(`${table}.list is not a method of the handle`)
	const page: unknown = await Reflect.apply(list, within, [])
	await transaction.commit()
	const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
	return Array.isArray(items) ? items.map((row: unknown) => String(typeof row === 'object' && row !== null ? Reflect.get(row, 'id') : '')).sort() : []
}

describe("a path along a foreign key that holds the row's tenant", () => {
	test("narrows the rows by the referenced row's column, through the guard", async () => {
		const layer = scoped(tablesWith({ 'label_id.public': { eq: true } }))
		bindScopedDatabaseProvisionally(layer, { database: openSqlite(storage), capabilities: alice })
		expect(await listed(dataAccessOf(layer))).toEqual(['k1'])
	})

	test("narrows a dimension table's rows the same way", async () => {
		const layer = scoped(tablesWith({ label_id: { isNull: false } }, [labelKey, tenantKey], { 'label_id.public': { eq: true } }))
		bindScopedDatabaseProvisionally(layer, { database: openSqlite(storage), capabilities: alice })
		expect(await listed(dataAccessOf(layer), 'projects', 'org', ['o1'])).toEqual(['p1'])
	})
})

describe('a path that could leave the tenant is refused', () => {
	const refusal = "outside the row's own containment"

	test('a single-column foreign key, without the shared ancestor', () => {
		expect(() => tablesWith({ 'label_id.public': { eq: true } }, [labelKey])).toThrow(refusal)
	})

	test('a tenant key with a further column, which a null in it would skip', () => {
		const wider: TaskKey = { columns: ['label_id', 'org_id', 'vendor_id'], table: 'labels', references: ['id', 'org_id', 'version'] }
		expect(() => tablesWith({ 'label_id.public': { eq: true } }, [labelKey, wider])).toThrow(refusal)
	})

	test("a single-column key to another unique column than the one the tenant key holds: it reads another tenant's row", () => {
		const bySlug: TaskKey = { columns: ['label_id'], table: 'labels', references: ['slug'] }
		expect(() => tablesWith({ 'label_id.public': { eq: true } }, [bySlug, tenantKey])).toThrow(refusal)
	})

	test('a table under another root, with which the row shares no ancestor', () => {
		expect(() => tablesWith({ 'vendor_id.trusted': { eq: true } })).toThrow(refusal)
	})
})
