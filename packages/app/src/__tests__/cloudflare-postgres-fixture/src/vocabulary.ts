import { defineVocabulary } from '@fabrika/app/contract'

/**
 * The application id, random per process: its schema and roles are cluster-wide, so two runs that share one Postgres
 * (two worktrees, `bun test --parallel`) never drop or truncate each other's.
 */
export const CFPG_APP = `cfpg${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`

export const vocabulary = defineVocabulary({
	app: CFPG_APP,
	dimensions: { workspace: {}, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes', 'notes.ping': 'Ping the notes anyone may' },
	roles: { editor: { grants: ['notes.read', 'notes.write'] } },
})
