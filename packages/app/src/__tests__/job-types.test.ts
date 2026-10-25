// The type half of jobs: each file in job-mistakes/ is one job handler mistake, refused on the line after its
// `// mistake:` marker with the diagnostic text below. The kick files also hold the forms that compile: `ctx.kick(job)`
// and `ctx.kick(job, { at })`.

import { describe } from 'bun:test'
import { join } from 'node:path'
import { expectMistakes } from './type-fixtures'

const EXPECTED: Readonly<Record<string, string>> = {
	'01-handler-for-undeclared-job.ts': "'jobs.reindex' is not in the contract. Declare the endpoint in fabrika.contract.ts first.",
	'02-missing-job-handler.ts': "Property 'flaky' is missing",
	'03-undeclared-action.ts': `Argument of type '"notes.delete"' is not assignable to parameter of type '"notes.read"'`,
	'04-kick-with-a-payload.ts': "'dealId' does not exist in type 'KickOptions'",
	'05-kick-at-a-timestamp.ts': "Type 'number' is not assignable to type 'Date'",
	'06-kick-later-an-undeclared-job.ts': `Argument of type '"digest"' is not assignable to parameter of type '"close"'`,
	'07-kick-a-payload-in-place-of-options.ts': "Argument of type 'string' is not assignable to parameter of type 'KickOptions'",
}

describe('the job handler mistakes are type errors', () => {
	expectMistakes(join(import.meta.dir, 'job-mistakes'), EXPECTED)
})
