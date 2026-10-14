import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	candidates: {
		scope: { dimension: 'candidate' },
		actions: { read: 'candidates.read' },
		version: 'version',
		createdBy: 'created_by',
		columns: { reason_id: { write: 'candidates.review' } },
	},
	positions: {
		scope: { app: 'the open positions an administrator edits' },
		actions: { read: 'positions.read', insert: 'positions.manage', update: 'positions.manage', delete: 'positions.manage' },
		insert: ['title'],
		update: ['title', 'active'],
		version: 'version',
		createdBy: 'created_by',
	},
	reasons: {
		scope: { app: 'the decision reasons an administrator edits' },
		actions: { read: 'candidates.review', insert: 'reasons.manage', update: 'reasons.manage' },
		insert: ['label'],
		update: ['label', 'active'],
		version: 'version',
		createdBy: 'created_by',
	},
	exports: {
		scope: { app: 'the log of every export across all candidates' },
		actions: { read: 'audit.read', insert: 'candidates.read' },
		insert: ['rows'],
		createdBy: 'created_by',
	},
})
