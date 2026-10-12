import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	applications: { scope: { inbox: 'apply', read: 'applications.read' } },
	messages: { scope: { inbox: 'contact', read: 'messages.read' } },
})
