import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	candidates: {
		scope: { dimension: 'candidate', key: 'id' },
		actions: { read: 'candidates.read', insert: 'candidates.process' },
		insert: ['email', 'name'],
		version: 'version',
		createdBy: 'created_by',
	},
	registrations: { scope: { inbox: 'register', read: 'candidates.process' } },
	applications: { scope: { inbox: 'apply', read: 'candidates.process' } },
	reattach_requests: {
		scope: { app: 'the photos a test asks the reattach job to attach to a known candidate' },
		actions: { read: 'candidates.process', insert: 'candidates.process', update: 'candidates.process' },
		insert: ['email', 'photo'],
		update: ['outcome'],
	},
})
