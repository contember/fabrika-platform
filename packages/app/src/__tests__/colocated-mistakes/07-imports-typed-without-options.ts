import { defineApp, type KitImport } from '@fabrika/app/contract'
import type { Tables } from '@fabrika/db/tables'
import { tables } from '../kit-fixture/src/db/tables'
import { vocabulary } from '../kit-fixture/src/vocabulary'

type TablesOf<T> = T extends Tables<infer DB, infer P> ? { readonly db: DB; readonly policies: P } : never
type KitTables = TablesOf<typeof tables>

// mistake: the imports are only a type argument, so the runtime builds no imports section for the contract to promise
export const kit = defineApp<typeof vocabulary, KitTables['db'], KitTables['policies'], { readonly catalog: KitImport }>(vocabulary, tables)
