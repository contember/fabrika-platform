// An application that declares notifications (ADR-0088): the Cloudflare fixture's notes table, a member root SPA, a
// public identification page for a terminal, and the SQLite database its subscriptions live in.

import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { defineTables } from '@fabrika/db/tables'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { columns } from '../cloudflare-fixture/src/db/schema.generated'

export const pushVocabulary = defineVocabulary({
	app: 'notes',
	dimensions: { workspace: {}, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes' },
	roles: { editor: { grants: ['notes.read', 'notes.write'] } },
	terminal: { identify: '/identify' },
	notifications: true,
})

export const pushTables = defineTables(pushVocabulary, columns)({
	notes: {
		scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write' },
		insert: ['title'],
		update: ['title'],
		version: 'version',
		createdBy: 'created_by',
	},
})

export const pushContract = defineApp(pushVocabulary, pushTables).contract((c) => ({
	web: c.spa('/', { dir: 'dist/web', access: { member: true } }),
	identify: c.spa('/identify', { dir: 'dist/identify', access: { public: true } }),
	health: c.health('/healthz'),
}))

/** A fresh SQLite database with the framework's tables and the notes table. */
export function pushDatabase(label: string) {
	return testDatabase({ migrations: new URL('../cloudflare-fixture/db/migrations/', import.meta.url), label })
}
