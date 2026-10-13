// The authorization vocabulary: a note lies in a workspace, the scope value IAM grants roles in. The contract, the
// table policies of src/db/tables.ts and their containment are typed by it.

import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'notes',
	// IAM's sign-in and password pages speak Czech for Notes, which the browser onboarding suite relies on.
	locale: 'cs',
	dimensions: {
		workspace: {},
		note: { in: 'workspace' },
	},
	actions: {
		'notes.read': 'Read notes and their attachments',
		'notes.write': 'Create notes, move them to the trash and attach files',
		'notes.delete': 'Delete notes and attachments',
	},
	roles: {
		reader: { grants: ['notes.read'] },
		author: { grants: ['notes.read', 'notes.write'] },
		editor: { grants: ['notes.read', 'notes.write', 'notes.delete'] },
	},
})
