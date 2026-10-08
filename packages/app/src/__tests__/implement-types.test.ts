// The type half of `implement`: each file in implement-mistakes/ is one handler mistake from the parser spike
// (05–10), refused on the line after its `// mistake:` marker with the diagnostic text below.

import { describe } from 'bun:test'
import { join } from 'node:path'
import { expectMistakes } from './type-fixtures'

const EXPECTED: Readonly<Record<string, string>> = {
	'05-handler-returns-undeclared-field.ts': "handler 'api.notes.get' returns fields the contract output does not declare. Return only declared fields",
	'06-handler-for-undeclared-endpoint.ts': "'api.notes.adminDump' is not in the contract. Declare the endpoint in fabrika.contract.ts first.",
	'07-missing-handler.ts': "Property 'remove' is missing",
	'08-input-field-removed-by-on.ts': "Property 'id' does not exist on type",
	'09-ref-for-wrong-action.ts': `Type '"notes.read"' is not assignable to type '"notes.delete"'`,
	'10-handler-for-health-mount.ts': "'health' is a health mount; it takes no handler. Remove it from handlers.",
}

describe('the handler mistakes are type errors', () => {
	expectMistakes(join(import.meta.dir, 'implement-mistakes'), EXPECTED)
})
