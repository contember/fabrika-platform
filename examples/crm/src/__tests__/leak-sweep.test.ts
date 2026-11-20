// The leak sweep, which this application opts into: every endpoint that answers rows of a scope, asked from two scopes
// that share no value. It fails only on a leak and prints a hint for whatever it could not check. The inputs name what
// a sample cannot: an attachment of the deal the case reaches, and a person who is a member of its org.

import { GENERATED_MEMBER, GENERATED_ROW_PREFIX, leakSweep } from '@fabrika/app/testing/isolation'
import { testDatabase } from '@fabrika/db/testing'
import app from '../app'
import { tables } from '../db/tables'

const attachment = { id: `${GENERATED_ROW_PREFIX}deal_attachments` }

leakSweep(app, tables, await testDatabase({ migrations: new URL('../../db/migrations/', import.meta.url), label: 'leak-sweep.test.ts' }), {
	inputs: { 'api.attachments.download': attachment, 'api.attachments.remove': attachment, 'api.deals.assign': { newOwner: GENERATED_MEMBER } },
})
