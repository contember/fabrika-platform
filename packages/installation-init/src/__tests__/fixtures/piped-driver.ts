// Two questions with a real child process between them, the shape `platform init` has: it confirms,
// spawns `git`/`gh`, then asks again. Driven by `prompt.test.ts` over a piped stdin.

import { text } from '../../prompt'
import { run } from '../../shell'

const first = await text('Q1')
console.log(`FIRST:${first}`)
await run({ command: 'cat', args: [], cwd: import.meta.dir })
console.log('CHILD-DONE')
const second = await text('Q2')
console.log(`SECOND:${second}`)
