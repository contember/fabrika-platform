// Run by orm.test.ts in a process of its own: the database ends an invocation's connection inside its transaction,
// the COMMIT fails, and a one-connection pool still serves the next invocation. Bun's driver rejects its release of
// the dead connection without anyone awaiting it; in a process of its own that rejection is printed, not attributed
// to a test. Prints one result line per step, and the URL never.

import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { Database, InvocationTransaction, runFixedStatement } from '../../database'
import { DatabaseError } from '../../errors'

const url = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? ''
const database = openPostgres({ url, schema: 'public', max: 1 })
const admin = new SQL({ url, adapter: 'postgres', max: 1 })

const lost = new InvocationTransaction(database, false)
const [backend] = await runFixedStatement(await lost.session(), 'select pg_backend_pid() as pid', [])
await admin.unsafe('select pg_terminate_backend($1)', [typeof backend === 'object' && backend !== null ? Reflect.get(backend, 'pid') : 0])
const failed = await lost.commit().then(() => null, (error: unknown) => error)
console.log(`commit: ${failed instanceof DatabaseError ? 'DatabaseError' : String(failed)}`)
console.log(`released: ${lost.released}`)
const next = new InvocationTransaction(database, true)
const answer = await Promise.race([
	next.session().then((session) => runFixedStatement(session, 'select 1 as one', [])),
	Bun.sleep(3000).then(() => 'waiting'),
])
console.log(`next: ${JSON.stringify(answer)}`)
await next.commit()
await admin.close()
process.exit(0)
