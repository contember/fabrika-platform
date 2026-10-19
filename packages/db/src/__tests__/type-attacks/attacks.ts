// Compiled by type-attacks.test.ts, never by the package's typecheck. Every statement under `// attack:` must be
// a type error; every statement under `// allowed:` must compile (the runtime refuses those, see store.test.ts).

import { type ColumnType, type Generated, sql } from 'kysely'
import type { Ref, Within } from '../../capability'
import { defineTables } from '../../policy'
import { defineChildStore, defineStore, scoped } from '../../store'
import type { TypedColumnList } from '../../vocabulary-tables'
import { columns } from '../fixtures/schema'
import { tables, vocabulary } from '../fixtures/tables'

declare const read: Within<'workspace', 'notes.read'>
declare const write: Within<'workspace', 'notes.write'>
declare const noteRead: Ref<'note', 'notes.read'>
declare const noteWrite: Ref<'note', 'notes.write'>
declare const noteReadOrDelete: Ref<'note', 'notes.read' | 'notes.delete'>
declare const workspaceWrite: Ref<'workspace', 'notes.write'>
declare const workspaceAdmin: Ref<'workspace', 'workspaces.admin'>
declare const organizationCreate: Ref<'organization', 'organizations.create'>

const database = scoped(tables)
const notes = defineStore(database, 'notes', (t) => t)
const comments = defineChildStore(database, 'note_comments', (t) => t)
const workspaces = defineStore(database, 'workspaces', (t) => t)
const organizations = defineStore(database, 'organizations', (t) => t)

// attack: the locator from the application-facing object, which reads existence without a capability
database.locate('note', 'n2')

// attack: connecting the layer from application code
database.connect({ database: null, capabilities: { resolve: () => null } })

// attack: where(sql`true or 1=1`)
notes.select(read, (q) => q.where(sql`true or 1=1`))

// attack: an expression in the value position
notes.select(read, (q) => q.where('title', '=', sql`(select value from secrets limit 1)`))

// attack: an operator outside the literal set
notes.select(read, (q) => q.where('title', 'or 1=1 --', 'x'))

// attack: a subquery as the in-list
notes.select(read, (q) => q.where('id', 'in', (eb: { selectFrom(table: string): unknown }) => eb.selectFrom('secrets')))

// attack: .union(…)
notes.select(read, (q) => q.union(q))

// attack: clearWhere()
notes.select(read, (q) => q.clearWhere())

// attack: execute() inside the callback
notes.select(read, (q) => q.execute())

// attack: selectFrom another table
notes.select(read, (q) => q.selectFrom('secrets'))

// attack: modifyEnd(sql`…`)
notes.select(read, (q) => q.modifyEnd(sql`union select * from secrets`))

// attack: $call
notes.select(read, (q) => q.$call((b: unknown) => b))

// attack: $if
notes.select(read, (q) => q.$if(true, (b: unknown) => b))

// attack: withPlugin
notes.select(read, (q) => q.withPlugin({}))

// attack: with (CTE)
notes.select(read, (q) => q.with('x', () => q))

// attack: join a table that is not a declared child
notes.select(read, (q) => q.join('secrets', (s) => s))

// attack: join a child whose read action is not the capability's
notes.select(read, (q) => q.join('note_flags', (f) => f))

// attack: a column of another table
notes.select(read, (q) => q.columns(['value']))

// attack: a column with its own read action
notes.select(read, (q) => q.columns(['internal']))

// attack: filtering on a column with its own read action
notes.select(read, (q) => q.where('internal', '=', 'x'))

// attack: a Within for notes.write cannot list (the read action is notes.read)
notes.select(write, (q) => q)

// attack: a Ref where a Within is needed
notes.select(noteRead, (q) => q)

// attack: a Within where a Ref is needed
notes.get(read)

// attack: a bare id instead of a Ref
notes.get('n1')

// attack: a read Ref passed to remove
notes.remove(noteRead)

// attack: a Ref holding a union of actions passed to remove
notes.remove(noteReadOrDelete)

// attack: extra key in an insert object literal
notes.insert(workspaceWrite, { title: 'x', body: null, workspace_id: 'w9' })

// attack: a scope column in an update
notes.update(noteWrite, { workspace_id: 'w9' }, { expectVersion: 1 })

// attack: the version column in an update
notes.update(noteWrite, { version: 9 }, { expectVersion: 1 })

// attack: a versioned table without expectVersion
notes.update(noteWrite, { title: 'x' })

// attack: expectVersion on a table without a version column
workspaces.update(workspaceAdmin, { name: 'x' }, { expectVersion: 1 })

// attack: move a table that has no container
organizations.move(organizationCreate, organizationCreate)

// attack: a workspace moves into an organization, not into another workspace
workspaces.move(workspaceAdmin, workspaceAdmin)

// attack: a mutation answers an acknowledgement, not row data
notes.update(noteWrite, { title: 'x' }, { expectVersion: 1 }).then((answer) => answer.body)

// attack: an insert answers an acknowledgement, not row data
notes.insert(workspaceWrite, { title: 'x', body: null }).then((answer) => answer.title)

// attack: a child table has no move
comments.move(noteRead, workspaceWrite)

// attack: a workspace Ref cannot address a child row (it needs the parent note Ref)
comments.remove(workspaceWrite, 'c1')

// attack: a child table through defineStore
defineStore(database, 'note_comments', (t) => t)

// attack: a dimension table through defineChildStore
defineChildStore(database, 'notes', (t) => t)

// attack: a reference table has no store
defineStore(database, 'countries', (t) => t)

// attack: secrets has no container, so a workspace Within cannot list it
defineStore(database, 'secrets', (t) => t.select(read, (q) => q))

// attack: a table without a policy
defineTables(vocabulary, columns)({ workspaces: { scope: { dimension: 'workspace', key: 'id' }, actions: { read: 'notes.read' } } })

// attack: a reference table written by handlers
defineTables(vocabulary, columns)({ ...tables_, countries: { scope: { reference: 'lookup' }, actions: { read: 'notes.read' }, insert: ['name'] } })

// attack: an insert column the table does not have
defineTables(vocabulary, columns)({
	...tables_,
	secrets: { scope: { dimension: 'secret', key: 'id' }, actions: { read: 'secrets.admin' }, insert: ['title'] },
})

// attack: an action outside the vocabulary
defineTables(vocabulary, columns)({ ...tables_, secrets: { scope: { dimension: 'secret', key: 'id' }, actions: { read: 'secrets.raed' } } })

// attack: a BIGINT version column, which Postgres returns as a string
defineTables(ledgerVocabulary, versionedColumns)({ ledgers: { ...ledger, version: 'big' } })

// attack: a nullable version column
defineTables(ledgerVocabulary, versionedColumns)({ ledgers: { ...ledger, version: 'maybe' } })

// attack: a text version column
defineTables(ledgerVocabulary, versionedColumns)({ ledgers: { ...ledger, version: 'id' } })

// allowed: an INTEGER version column, generated or not
defineTables(ledgerVocabulary, versionedColumns)({ ledgers: { ...ledger, version: 'counter' } })
defineTables(ledgerVocabulary, versionedColumns)({ ledgers: { ...ledger, version: 'generated' } })

// allowed: excess properties are checked on object literals only (the runtime refuses the key)
const values = { title: 'x', body: null, workspace_id: 'w9' }
notes.insert(workspaceWrite, values)

// allowed: method parameters are bivariant, so a widened handle takes a read Ref (the runtime refuses it)
const widened: { remove(ref: Ref<string, string>): Promise<void> } = notes
widened.remove(noteRead)

// allowed: a structural copy of the type-only member (the runtime refuses it: it is not a minted capability)
notes.get({ '~capability': { kind: 'ref', dimension: 'note', action: 'notes.read' } })

declare const tables_: {
	organizations: { scope: { dimension: 'organization'; key: 'id' }; actions: { read: 'notes.read' } }
	workspaces: {
		scope: { dimension: 'workspace'; key: 'id'; in: { dimension: 'organization'; column: 'organization_id' } }
		actions: { read: 'notes.read' }
	}
	notes: { scope: { dimension: 'note'; key: 'id'; in: { dimension: 'workspace'; column: 'workspace_id' } }; actions: { read: 'notes.read' } }
	note_comments: {
		scope: { child: 'notes'; key: 'id'; column: 'note_id'; inherit: ['workspace_id', 'organization_id'] }
		actions: { read: 'notes.read' }
	}
	note_flags: {
		scope: { child: 'notes'; key: 'id'; column: 'note_id'; inherit: ['workspace_id', 'organization_id'] }
		actions: { read: 'notes.read' }
	}
	secrets: { scope: { dimension: 'secret'; key: 'id' }; actions: { read: 'secrets.admin' } }
	countries: { scope: { reference: 'lookup' }; actions: { read: 'notes.read' } }
}

interface Versioned {
	ledgers: {
		id: string
		big: ColumnType<string, bigint | number | string, bigint | number | string>
		maybe: number | null
		counter: number
		generated: Generated<number>
	}
}
declare const versionedColumns: TypedColumnList<Versioned>
declare const ledgerVocabulary: { dimensions: { ledger: {} }; actions: { 'notes.read': 'Read notes' } }
declare const ledger: { scope: { dimension: 'ledger'; key: 'id' }; actions: { read: 'notes.read' } }
