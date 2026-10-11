import type { VocabularyPolicyMap } from '../../vocabulary-tables'
import { type DB, derived, type vocabulary } from '../derived-tables/schema'

export const policies: VocabularyPolicyMap<DB, typeof vocabulary> = {
	...derived,
	// mistake: folders has no workspace_id, so its container column must be named
	folders: { scope: { dimension: 'folder' }, actions: { read: 'notes.read' } },
}
