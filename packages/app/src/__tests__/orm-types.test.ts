// The type half of the mini-ORM: each file in `orm-mistakes/` is one data mistake a handler makes, refused on the line
// after its `// mistake:` marker. 08–11 run on the probe task tracker (`probe-tasks/`), 12–17 on application-wide data
// (`app-wide-fixture/`). The API matrix itself is pinned by `kit-fixture/matrix.ts` (`kit-types.test.ts`).

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
	'08-update-a-column-another-action-writes.ts':
		"Object literal may only specify known properties, and 'title' does not exist in type '{ assignee?: string | null | undefined; }'.",
	'09-update-with-an-action-that-writes-nothing.ts':
		`Type 'Unavailable<"update on tasks needs the action 'tasks.write' or a column's own write action, and this endpoint holds 'tasks.read'">' has no call signatures.`,
	'10-a-day-as-a-date.ts': "Type 'Date' is not assignable to type 'string'.",
	'11-row-of-an-action-the-table-does-not-name.ts':
		`Type '"tasks.raed"' does not satisfy the constraint '"tasks.read" | "tasks.write" | "tasks.assign"'.`,
	'12-app-insert-with-the-read-action.ts':
		`Type 'Unavailable<"insert on positions needs the action 'positions.manage', and this endpoint holds 'positions.read'">' has no call signatures.`,
	'13-application-table-under-on.ts':
		`Property 'count' does not exist on type 'Unavailable<"positions is an application table: read it through ctx.db.app.positions, or declare access: { action, app: true }">'.`,
	'14-app-list-with-another-read-action.ts':
		`Type 'Unavailable<"a count of candidates needs its read action 'candidates.read' or an action of its appRead or appCount, and this endpoint holds 'positions.manage'">' has no call signatures.`,
	'15-scoped-read-of-an-application-table-with-another-action.ts':
		`Property 'count' does not exist on type 'Unavailable<"a scoped endpoint reads reasons with its read action 'candidates.review', and this endpoint holds 'candidates.read'">'.`,
	'17-app-list-with-a-counting-action.ts':
		`Type 'Unavailable<"a list of candidates needs its read action 'candidates.read' or an action of its appRead, and this endpoint holds 'candidates.count'">' has no call signatures.`,
	'16-scoped-write-of-an-application-table.ts':
		`Type 'Unavailable<"a scoped endpoint only reads an application table: write it from an endpoint declared access: { action, app: true }">' has no call signatures.`,
}

/**
 * Held to their line and text only: the compiler elaborates a condition tuple position by position, and a write's
 * answer is printed as its two fields, which is what the message must show.
 */
const ELABORATED = ['04-where-value-of-another-type.ts', '06-saved-is-not-the-row.ts']

describe('the mini-ORM mistakes are type errors at their line', () => {
	expectMistakes(join(import.meta.dir, 'orm-mistakes'), EXPECTED, { plain: true, elaborated: ELABORATED })
})
