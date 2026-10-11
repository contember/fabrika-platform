// The type half of the mini-ORM: each file in `orm-mistakes/` is one data mistake a handler makes, refused on the line
// after its `// mistake:` marker. The API matrix itself is pinned by `kit-fixture/matrix.ts` (`kit-types.test.ts`).

import { describe } from 'bun:test'
import { join } from 'node:path'
import { expectMistakes } from './type-fixtures'

const EXPECTED: Readonly<Record<string, string>> = {
	'01-remove-without-expect-version.ts': 'Expected 1 arguments, but got 0.',
	'02-update-a-stamped-column.ts': "Object literal may only specify known properties, and 'version' does not exist in type",
	'03-order-by-a-hidden-column.ts': `Type '"margin"' is not assignable to type`,
	'04-where-value-of-another-type.ts': `Type '"open"' is not assignable to type '"lead" | "proposal" | "won" | "lost"'`,
	'05-update-under-in.ts': `Type 'Unavailable<"update acts on one object: declare access with on">' has no call signatures.`,
	'06-saved-is-not-the-row.ts': "Property 'title' does not exist on type '{ readonly id: string; readonly version: number; }'.",
	'07-from-row-missing-column.ts': "Property 'name' is missing in type '{ id: string; }'",
}

/**
 * Held to their line and text only: the compiler elaborates a condition tuple position by position, and a write's
 * answer is printed as its two fields, which is what the message must show.
 */
const ELABORATED = ['04-where-value-of-another-type.ts', '06-saved-is-not-the-row.ts']

describe('the mini-ORM mistakes are type errors at their line', () => {
	expectMistakes(join(import.meta.dir, 'orm-mistakes'), EXPECTED, { plain: true, elaborated: ELABORATED })
})
