// The type half of the staged kit (vocabulary → tables → kit → groups → contract). `kit-fixture/` is a small CRM in
// that form whose `matrix.ts` pins the API matrix; it compiles clean. Each file in `kit-mistakes/` is one mistake an
// agent makes, refused on the line after its `// mistake:` marker in at most two lines that name the fix.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { compileFixtures, expectMistakes } from './type-fixtures'

const EXPECTED: Readonly<Record<string, string>> = {
	'01-group-in-another-file/group.ts': 'the handler returns margin, which the output does not declare: return only declared fields',
	'02-groups-with-different-callers.ts': 'every group of one RPC mount names the same callers, in the same order',
	// The compiler lists a union's fields in no fixed order.
	'03-wrong-output-field.ts': 'which the output does not declare: return only declared fields',
	'04-get-for-update-in-a-query.ts': 'getForUpdate locks the row, so it runs only in a mutation: declare the endpoint with r.mutation',
	'05-sql-without-declaration.ts': "ctx.sql needs a declaration: add sql: 'read' (or 'write' on a mutation) to this site",
	'06-unscoped-table-outside-tables.ts':
		`'invoices' does not exist in type 'UnscopedDeclaration<"orgs" | "companies" | "deals" | "deal_activities" | "countries", "read">'`,
	'07-unscoped-table-not-declared.ts': "deals is outside this site's scope: declare unscoped: { deals: 'read' } on it",
	'08-write-sql-on-a-query.ts': `Type '"write"' is not assignable to type '"read"'`,
	'09-remove-with-another-action.ts': "delete on deals needs the action 'crm.delete', and this endpoint holds 'deals.write'",
	'10-untyped-column-list.ts': 'the column list carries no row types: import columns from the generated src/db/schema.generated.ts',
	'11-declaration-only-in-a-type.ts': "Types of property 'sql' are incompatible",
	'12-container-the-vocabulary-does-not-name.ts': `Type '"org"' is not assignable to type '"company"'`,
	'13-unscoped-insert-without-its-scope.ts': "Property 'org_id' is missing in type '{ name: string; }'",
	'14-widened-capability.ts': `Property 'margin' does not exist on type 'Omit<DealsTable, "margin">'`,
	'15-reference-hidden-column.ts': `Property 'note' does not exist on type 'Omit<CountriesTable, "note">'`,
	'16-unknown-unscoped-table-beside-a-known-one.ts': 'invoices is not a table of src/db/tables.ts',
	'17-hidden-column.ts': `Property 'margin' does not exist on type 'Omit<DealsTable, "margin">'`,
	'18-missing-handle.ts': 'add .handle(…) to deals.get: every endpoint takes its handler beside it',
	'19-access-dimension-typo.ts': `Type '"deall"' is not assignable to type '"org" | "company" | "deal"'. Did you mean '"deal"'?`,
	'20-connect-widened-list.ts': "connect names its connectors as a literal list: connect: ['catalog']",
	'21-group-typed-to-admit-pending-endpoints.ts': 'add .handle(…) to group.* (its type admits an endpoint without a handler)',
	'22-job-update-outside-its-transaction.ts': 'a job writes inside ctx.transaction((tx) => …): use tx.db there',
	'23-job-unscoped-insert-outside-its-transaction.ts': 'a job writes inside ctx.transaction((tx) => …): use tx.db there',
}

/**
 * The compiler elaborates these through the declaration's own types, so they are held to their line and text only:
 * an optional field an annotation allows, and a scope union of the table policy (its wording is WU2's to refine).
 */
const ELABORATED = ['11-declaration-only-in-a-type.ts', '12-container-the-vocabulary-does-not-name.ts']

describe('the staged kit', () => {
	test('the kit fixture and its API matrix compile clean', () => {
		const diagnostics = [...compileFixtures(join(import.meta.dir, 'kit-fixture')).entries()].flatMap(([file, found]) =>
			found.map((diagnostic) => `${file}:${diagnostic.line + 1} ${diagnostic.text}`)
		)
		expect(diagnostics).toEqual([])
	}, 60_000)

	describe('the kit mistakes are type errors at their line', () => {
		expectMistakes(join(import.meta.dir, 'kit-mistakes'), EXPECTED, { plain: true, elaborated: ELABORATED })
	})
})
