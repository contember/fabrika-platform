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
	'24-sql-on-a-kit-without-tables.ts': 'ctx.sql runs on @fabrika/db: a kit without tables (defineApp(vocabulary)) declares no sql',
	'25-reserved-role-name.ts': 'admin is a role IAM defines itself for every application (reserved: admin): choose another name',
	// The typo is the only diagnostic: the mount does not ask for a `.handle(…)` the endpoint has.
	'26-handler-error-stays-in-the-handler.ts': "Property 'lable' does not exist on type 'UserPrincipal'. Did you mean 'label'?",
	'27-table-the-access-form-does-not-reach.ts': "deals is not under in: 'org' (it lies in company): declare access in: 'company' or on: 'deal'",
	// The compiler lists a union's fields in no fixed order.
	'28-raw-row-for-a-camel-case-output.ts': 'where the output is camelCase: map it with fromRow(Schema, row) from @fabrika/app',
	'29-members-without-the-list-action.ts': "listing the members of org needs the action 'crm.read'; get(principalId) checks one",
	'30-attachment-handler-returns-no-rows.ts': 'an attachment handler returns its rows: an array of its row schema, with nothing around it',
	'31-job-links-without-issues.ts': "declare issues: '<link mount>' on this job to issue its share links",
	'32-form-kicks-an-unknown-job.ts': "then names a job of the contract's jobs section",
	// The compiler lists a union's members in no fixed order.
	'33-form-field-that-is-no-inbox-column.ts': 'the inbox registrations has no column fullName: each input field is named like its column (columns: ',
	'34-unscoped-write-of-a-reference-table.ts':
		"countries is a reference table, which no site writes: its rows come from a migration, so declare unscoped: { countries: 'read' }",
	'35-unscoped-write-of-an-inbox.ts': "registrations is a form's inbox, which only its form writes: declare unscoped: { registrations: 'read' }",
	'36-widened-honeypot/contract.ts': "honeypot names the field the page hides as a literal: honeypot: '<field>'",
	'37-widened-inbox-name.ts': "appendTo names the form's inbox table as a literal: appendTo: '<inbox table>'",
	'38-append-to-a-table-that-is-no-inbox.ts': 'candidates is not an inbox table of src/db/tables.ts (inboxes: ',
	'39-unscoped-union-mode-of-a-reference-table.ts':
		"countries is a reference table, which no site writes: its rows come from a migration, so declare unscoped: { countries: 'read' }",
	'40-unscoped-optional-mode-of-an-inbox.ts':
		"registrations is a form's inbox, which only its form writes: declare unscoped: { registrations: 'read' }",
	'41-unscoped-get-of-a-reference-table.ts': 'countries is a reference table, which has no key: read it with list',
	'42-unscoped-get-of-an-inbox.ts': "registrations is a form's inbox, which has no key: read it with list",
	'43-member-label-without-a-labels-directory.ts': "'member.label' is possibly 'null'.",
	'44-remove-files-in-a-query.ts': 'a query reads only; remove files in a mutation',
	'45-remove-files-outside-a-job-transaction.ts': 'a job removes files inside ctx.transaction((tx) => …), as tx.files',
	'46-then-on-a-query.ts': 'a query kicks no job: declare then on a mutation',
	'47-then-not-a-literal.ts': "then names one cron job, as a literal: then: 'mailing'",
	'48-job-mail-without-mailer.ts': "declare mailer: 'installation' or 'own' on this job to send mail",
	'49-mail-in-an-endpoint.ts': 'an endpoint sends no mail: write an outbox row and kick a job that declares mailer',
	'50-mail-in-a-webhook.ts': 'an endpoint sends no mail: write an outbox row and kick a job that declares mailer',
	'51-form-file-that-is-no-inbox-column.ts': 'the inbox registrations has no column selfie: each input field is named like its column (columns: ',
}

/**
 * The compiler elaborates these through the declaration's own types, so each is held to its line and text only: an
 * optional field an annotation allows, a form's `then`, which only the whole surface can check, and an options or
 * `unscoped` object typed apart from its call, whose whole type the compiler prints.
 */
const ELABORATED = [
	'11-declaration-only-in-a-type.ts',
	'32-form-kicks-an-unknown-job.ts',
	'36-widened-honeypot/contract.ts',
	'39-unscoped-union-mode-of-a-reference-table.ts',
	'40-unscoped-optional-mode-of-an-inbox.ts',
]

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
