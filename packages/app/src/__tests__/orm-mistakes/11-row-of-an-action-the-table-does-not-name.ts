import type { RowOf } from '@fabrika/db/tables'
import type { tables } from '../probe-tasks/src/db/tables'

// mistake: a row type for an action the table does not name
export type Row = RowOf<typeof tables, 'tasks', 'tasks.raed'>
