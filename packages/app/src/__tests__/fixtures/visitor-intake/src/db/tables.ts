import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	candidates: {
		scope: { dimension: 'candidate', key: 'id' },
		actions: { read: 'candidates.read', insert: 'candidates.process', update: 'candidates.verify' },
		insert: ['email', 'name'],
		update: ['verified_at'],
		version: 'version',
		createdBy: 'created_by',
		// The link delivery is the intake job's own, written through its declared SQL; a link holder never reads it.
		columns: {
			link_state: { read: 'candidates.process' },
			link_id: { read: 'candidates.process' },
			link_seal: { read: 'candidates.process' },
			revoke_link_id: { read: 'candidates.process' },
			sends: { read: 'candidates.process' },
			window_started_at: { read: 'candidates.process' },
			attempts: { read: 'candidates.process' },
			last_failure: { read: 'candidates.process' },
		},
	},
	registrations: { scope: { inbox: 'register', read: 'candidates.process' } },
	resend_requests: { scope: { inbox: 'resend', read: 'candidates.process' } },
})
