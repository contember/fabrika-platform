// The type half of the typed client and the test kit: each file in client-mistakes/ is refused on the line after its `// mistake:`
// marker with the diagnostic text below.

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
	'11-link-upload-names-an-owner.ts': "Argument of type 'string' is not assignable to parameter of type 'Blob'.",
	'12-link-files-of-a-collection-without-link.ts': "Property 'attachments' does not exist",
	'13-result-of-is-the-output.ts': "Type 'string' is not assignable to type 'number'.",
	'14-input-of-is-the-input.ts': "Property 'expectVersion' is missing",
}

describe('client and test kit mistakes are type errors', () => {
	expectMistakes(join(import.meta.dir, 'client-mistakes'), EXPECTED)
})
