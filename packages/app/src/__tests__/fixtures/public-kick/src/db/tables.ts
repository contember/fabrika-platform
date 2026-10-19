import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

const VISITORS = { app: 'anonymous visitors before a record exists' } as const
const POLICY = {
	scope: VISITORS,
	actions: { read: 'signups.process', insert: 'signups.register', delete: 'signups.process' },
	insert: ['email'],
} as const

export const tables = defineTables(vocabulary, columns)({
	signups: POLICY,
	applications: POLICY,
	notices: POLICY,
})
