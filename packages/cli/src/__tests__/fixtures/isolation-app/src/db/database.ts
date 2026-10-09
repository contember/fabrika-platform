import { scoped } from '@fabrika/db'
import { tables } from './tables'

/** The application's data layer, which `implement` takes; `boot` connects it. */
export const database = scoped(tables)
