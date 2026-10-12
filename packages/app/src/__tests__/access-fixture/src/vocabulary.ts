import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'notes',
	dimensions: { workspace: {}, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes', 'notes.share': 'Share notes' },
	roles: { writer: { grants: ['notes.write'] }, editor: { grants: ['notes.read', 'notes.write', 'notes.share'] } },
})
