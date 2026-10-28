import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'cfpg',
	dimensions: { workspace: {}, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes', 'notes.ping': 'Ping the notes anyone may' },
	roles: { editor: { grants: ['notes.read', 'notes.write'] } },
})
