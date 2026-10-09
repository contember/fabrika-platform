// The type half of jobs: each file in job-mistakes/ is one job handler mistake, refused on the line after its
// `// mistake:` marker with the diagnostic text below.

import { describe } from 'bun:test'
import { join } from 'node:path'
import { expectMistakes } from './type-fixtures'

const EXPECTED: Readonly<Record<string, string>> = {
	'01-handler-for-undeclared-job.ts': "'jobs.reindex' is not in the contract. Declare the endpoint in fabrika.contract.ts first.",
	'02-missing-job-handler.ts': "Property 'flaky' is missing",
	'03-undeclared-action.ts': `Argument of type '"notes.delete"' is not assignable to parameter of type '"notes.read"'`,
}

describe('the job handler mistakes are type errors', () => {
	expectMistakes(join(import.meta.dir, 'job-mistakes'), EXPECTED)
})
