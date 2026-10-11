import { defineApp, type KitImport } from '@fabrika/app/contract'
import { tables } from '../kit-fixture/src/db/tables'
import { vocabulary } from '../kit-fixture/src/vocabulary'

const options: { readonly imports?: { readonly catalog: KitImport } } = {}

// mistake: the options may hold no imports, so the contract could not promise an imports section
export const kit = defineApp(vocabulary, tables, options)
