// The colocated form's mistakes: each file in `colocated-mistakes/` is a handler or a site beside its declaration that
// an agent gets wrong, refused on the line after its `// mistake:` marker, in at most two lines that name the fix.

import { describe } from 'bun:test'
import { join } from 'node:path'
import { expectMistakes } from './type-fixtures'

const EXPECTED: Readonly<Record<string, string>> = {
	'01-missing-handle-in-a-nested-mount.ts': 'add .handle(…) to v1.companies.get: every endpoint takes its handler beside it',
	'02-target-on-over.ts': 'an over endpoint holds ctx.within, the scopes it may list in: declare access with on or in for ctx.target',
	'03-principal-of-another-caller.ts': `Type '"service"' is not assignable to type '"user"'`,
	'04-job-ref-of-an-undeclared-action.ts': `Argument of type '"crm.delete"' is not assignable to parameter of type '"crm.read"'`,
	'05-imports-that-may-be-absent.ts': "Type 'undefined' is not assignable to type 'KitImports'",
	'06-options-that-may-be-absent.ts': "Type 'undefined' is not assignable to type '{ readonly imports: { readonly catalog: KitImport; }; }'",
	'07-imports-typed-without-options.ts': 'Expected 3 arguments, but got 2.',
}

/** The compiler elaborates an options object through its types, so these are held to their line and text. */
const ELABORATED = ['05-imports-that-may-be-absent.ts', '06-options-that-may-be-absent.ts']

describe('the colocated mistakes are type errors at their line', () => {
	expectMistakes(join(import.meta.dir, 'colocated-mistakes'), EXPECTED, { plain: true, elaborated: ELABORATED })
})
