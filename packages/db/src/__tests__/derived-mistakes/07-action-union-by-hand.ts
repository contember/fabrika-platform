import { defineTables } from '../../tables'
import { columns, type DB, derived } from '../derived-tables/schema'

// mistake: the form that names the action union by hand
export const tables = defineTables<DB, 'notes.read' | 'notes.write'>(columns)(derived)
