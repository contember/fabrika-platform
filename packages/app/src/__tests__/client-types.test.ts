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
}

describe('client and test kit mistakes are type errors', () => {
	expectMistakes(join(import.meta.dir, 'client-mistakes'), EXPECTED)
})
