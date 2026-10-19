import { defineTables } from '@fabrika/db/tables'
import { MAX_ATTEMPTS } from '../limits'
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
	registrations: {
		scope: { app: 'anonymous registrations before a candidate exists' },
		actions: { read: 'candidates.process', insert: 'candidates.register', update: 'candidates.process', delete: 'candidates.process' },
		insert: ['email', 'name'],
		update: ['last_failure'],
		queue: { attempts: 'attempts', due: 'due_at', maxAttempts: MAX_ATTEMPTS },
		version: 'version',
	},
	resend_requests: {
		scope: { app: 'anonymous resend requests, matched to a candidate by the intake job' },
		actions: { read: 'candidates.process', insert: 'candidates.register', delete: 'candidates.process' },
		insert: ['email'],
	},
	candidate_files: {
		scope: { child: 'candidates' },
		actions: { read: 'candidates.read', insert: 'candidates.attach' },
		insert: ['file'],
		files: { file: 'attachments' },
	},
})
