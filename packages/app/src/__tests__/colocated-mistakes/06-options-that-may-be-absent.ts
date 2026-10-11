import { defineApp, type KitImport } from '@fabrika/app/contract'
import { tables } from '../kit-fixture/src/db/tables'
import { vocabulary } from '../kit-fixture/src/vocabulary'

export const catalogApp = (options?: { readonly imports: { readonly catalog: KitImport } }): string =>
	// mistake: the options may be absent, so the contract could not promise an imports section
	defineApp(vocabulary, tables, options).contract((c) => ({ health: c.health('/healthz') })).surface.imports.catalog.app
