// The type half of the typed client, its React hooks and the test kit: each file in client-mistakes/ is refused on the line
// after its `// mistake:` marker with the diagnostic text below.

import { describe } from 'bun:test'
import { join } from 'node:path'
import { expectMistakes } from './type-fixtures'

const EXPECTED: Readonly<Record<string, string>> = {
	'01-undeclared-procedure.ts': "Property 'adminDump' does not exist",
	'02-undeclared-input-field.ts': "'ownerId' does not exist in type",
	'03-output-field-not-declared.ts': "Property 'internalScore' does not exist",
	'04-mount-without-procedures.ts': `Argument of type '"health"' is not assignable to parameter of type 'ClientMount<`,
	'05-link-client-without-key.ts': 'Expected 3 arguments, but got 2.',
	'06-test-grant-action-typo.ts': `Type '"notes.raed"' is not assignable to type`,
	'07-call-an-attachment-procedure.ts': "Type 'AttachmentProcedure<ZodObject<{ orgId: ZodString; }, $strict>>' has no call signatures.",
	'08-download-input-of-another-shape.ts': "'org' does not exist in type '{ orgId: string; }'",
	'09-link-caller-label.ts': "Type 'null' is not assignable to type 'string'.",
	'10-test-scope-dimension-typo.ts': `Argument of type '"workspaces"' is not assignable to parameter of type '"workspace" | "note"'.`,
	'13-result-of-is-the-output.ts': "Type 'string' is not assignable to type 'number'.",
	'14-input-of-is-the-input.ts': "Property 'expectVersion' is missing",
	'15-query-input-field.ts': "'noteId' does not exist in type '{ id: string; }'",
	'16-query-data-before-success.ts': "'note.data' is possibly 'undefined'.",
	'17-query-answer-field.ts': "Property 'body' does not exist on type '{ id: string; title: string; }'.",
	'18-mutation-input-field.ts': "Property 'workspaceId' is missing in type '{ title: string; }'",
	'19-infinite-query-of-no-page.ts': "is not assignable to parameter of type 'PagedProcedure<",
	'20-query-without-input.ts': "Type 'Record<never, never> | undefined' is not assignable to type '{ id: string; }'.",
	'21-mutation-result-field.ts': "Property 'data' does not exist on type 'MutationResult<{ id: string; title: string; }>'.",
}

describe('client and test kit mistakes are type errors', () => {
	expectMistakes(join(import.meta.dir, 'client-mistakes'), EXPECTED)
})
