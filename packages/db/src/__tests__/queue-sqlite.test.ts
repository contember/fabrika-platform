// A queue claim on SQLite (ADR-0065), over a bun:sqlite stand-in that binds at most 100 parameters a statement, as
// workerd does: a Within's scope values bind as one parameter, so a claim through a Within of up to MAX_WITHIN_VALUES
// values leases its rows and every row out of its scope stays due.

import { beforeEach, describe, expect, test } from 'bun:test'
import { MAX_WITHIN_VALUES } from '../capability'
import { bindScopedDatabase, type DataAccess, dataAccessOf, type DataSite } from '../framework'
import { readTables } from '../policy'
import { openSqlite } from '../sqlite'
import { type BunSqliteStorage, bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import { TestAuthority } from './fixtures/authority'

const migration = `
create table deals (id text primary key, org_id text not null, name text not null, unique (id, org_id)) strict;
create table report_requests (
	id text primary key,
	deal_id text not null,
	org_id text not null,
	kind text not null,
	result text,
	attempts integer not null default 0,
	next_attempt_at text,
	version integer not null,
	foreign key (deal_id, org_id) references deals (id, org_id)
) strict;
`

const vocabulary = {
	dimensions: { org: {}, deal: { in: 'org' } },
	actions: { 'crm.read': 'Read', 'reports.request': 'Request a report', 'reports.render': 'Render reports' },
}

const columns = {
	deals: { columns: ['id', 'org_id', 'name'], foreignKeys: [] },
	report_requests: {
		columns: ['id', 'deal_id', 'org_id', 'kind', 'result', 'attempts', 'next_attempt_at', 'version'],
		foreignKeys: [{ columns: ['deal_id', 'org_id'], table: 'deals', references: ['id', 'org_id'] }],
		timestamps: ['next_attempt_at'],
	},
}

const policies = {
	deals: { scope: { dimension: 'deal' }, actions: { read: 'crm.read' } },
	report_requests: {
		scope: { child: 'deals' },
		actions: { read: 'crm.read', insert: 'reports.request', update: 'reports.render' },
		insert: ['kind'],
		update: ['result'],
		queue: { attempts: 'attempts', due: 'next_attempt_at' },
		version: 'version',
	},
}

/** The largest `limit` a claim takes (the list limit). */
const MAX_CLAIM = 500

const job = new TestAuthority('job:drain')
let storage: BunSqliteStorage
let data: DataAccess

beforeEach(() => {
	storage = bunSqliteStorage()
	storage.sql.exec(migration)
	const layer = scoped(readTables(columns, policies, vocabulary))
	bindScopedDatabase(layer, { database: openSqlite(storage), capabilities: job })
	data = dataAccessOf(layer)
})

/** `count` organizations, each with one deal and one due report request. */
function seed(count: number): string[] {
	const orgs = Array.from({ length: count }, (_, index) => `o${String(index).padStart(4, '0')}`)
	const due = new Date(Date.now() - 60_000).toISOString()
	for (const org of orgs) {
		storage.sql.exec("insert into deals (id, org_id, name) values (?, ?, 'deal')", `d-${org}`, org)
		storage.sql.exec(
			"insert into report_requests (id, deal_id, org_id, kind, next_attempt_at, version) values (?, ?, ?, 'summary', ?, 1)",
			`r-${org}`,
			`d-${org}`,
			org,
			due,
		)
	}
	return orgs
}

async function claim(orgs: readonly string[], limit: number): Promise<string[]> {
	const site: DataSite = {
		kind: 'job',
		unscoped: {},
		principal: 'job:drain',
		tickMs: 60_000,
		check: () => undefined,
		session: async () => data.direct(),
	}
	const handle: unknown = data.handles(site).within(job.within('org', 'reports.render', orgs))
	const queue: unknown = typeof handle === 'object' && handle !== null ? Reflect.get(handle, 'report_requests') : undefined
	const method: unknown = typeof queue === 'object' && queue !== null ? Reflect.get(queue, 'claim') : undefined
	if (typeof method !== 'function') {
		throw new TypeError('report_requests.claim is not a method of the handle')
	}
	const rows: unknown = await Reflect.apply(method, queue, [{ limit }])
	if (!Array.isArray(rows)) {
		throw new TypeError('a claim answers an array')
	}
	return rows.map((row) => String(Reflect.get(row, 'id'))).sort()
}

function attempts(): Record<string, unknown>[] {
	return storage.sql.exec('select attempts, count(*) as n from report_requests group by attempts order by attempts').toArray()
}

describe('a claim through a Within of many scope values on SQLite', () => {
	for (const size of [101, MAX_WITHIN_VALUES]) {
		test(`leases the rows of a Within of ${size} values, and only those`, async () => {
			const orgs = seed(size + 5)
			const inScope = orgs.slice(0, size)
			// A claim takes at most MAX_LIST_LIMIT rows; by due, then key, so the first of the scope.
			const limit = Math.min(size, MAX_CLAIM)
			const leased = await claim(inScope, limit)
			expect(leased).toEqual(inScope.slice(0, limit).map((org) => `r-${org}`))
			expect(attempts()).toEqual([{ attempts: 0, n: orgs.length - limit }, { attempts: 1, n: limit }])
			// The rest of the scope is still due, and the next claim takes it; the rows out of scope never.
			const rest = await claim(inScope, MAX_CLAIM)
			expect(rest).toEqual(inScope.slice(limit).map((org) => `r-${org}`))
			expect(attempts()).toEqual([{ attempts: 0, n: 5 }, { attempts: 1, n: size }])
		})
	}
})
