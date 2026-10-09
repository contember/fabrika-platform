// The type half of `defineContract`: each file in contract-mistakes/ is one mistake a coding agent makes, marked
// `// mistake:` on the line before it. The package's compiler options must refuse exactly that line, with the
// diagnostic text below. The repository forbids `@ts-expect-error`, so the files are compiled here and excluded
// from the package typecheck. The parser spike's mistakes 05–10 are handler mistakes and belong to `implement`.

import { describe } from 'bun:test'
import { join } from 'node:path'
import { expectMistakes } from './type-fixtures'

const EXPECTED: Readonly<Record<string, string>> = {
	'01-forgot-access.ts': "Property 'access' is missing",
	'02-rpc-with-public-caller.ts': `Type '"public"' is not assignable to type 'RpcCaller'`,
	'03-action-typo.ts': `Did you mean '"notes.read"'?`,
	'04-wildcard-role.ts': `Type '"*"' is not assignable to type`,
	'11-loose-input.ts': 'a loose object admits undeclared keys: declare it with z.strictObject({ … })',
	'12-from-field-not-in-input.ts': `Type '"noteId"' is not assignable to type '"id"'`,
	'13-creates-dimension-without-creator.ts': `Type '"note"' is not assignable to type '"workspace"'`,
	'14-link-caller-on-rpc-mount.ts': `Type '"link"' is not assignable to type 'RpcCaller'`,
	'15-loose-output.ts': 'a loose object admits undeclared keys: declare it with z.strictObject({ … })',
	'16-wildcard-action.ts': 'an action is exact: a role grants listed actions, and * is not an action',
	'17-mutation-in-export.ts': `Type '"mutation"' is not assignable to type '"query"'`,
	'18-link-procedure-outside-grants.ts': `Type '"notes.delete"' is not assignable to type '"notes.read"'`,
	'19-options-set-builder-fields.ts': `is not assignable to type 'Owned<"kind" | "path">'`,
	'20-creates-contained-dimension.ts': `Type '"note"' is not assignable to type '"workspace"'`,
	'21-oauth-caller-on-rpc-mount.ts': `Type '"oauth"' is not assignable to type 'RpcCaller'`,
	'22-app-caller-on-rpc-mount.ts': `Type '"app:billing"' is not assignable to type 'RpcCaller'`,
}

describe('the contract mistakes are type errors', () => {
	expectMistakes(join(import.meta.dir, 'contract-mistakes'), EXPECTED)
})
