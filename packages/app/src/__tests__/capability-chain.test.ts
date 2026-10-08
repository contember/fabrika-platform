// A handler that resolves its own Ref and changes the containment chain it gets back changes nothing the data layer
// sees: every resolution is a fresh copy of the chain frozen at mint. Driven through `@fabrika/db`'s own stores and
// recording dialect, so the witness is the SQL parameters of the statement.

import { Database } from '@fabrika/db'
import { describe, expect, test } from 'bun:test'
import { RecordingDialect } from '../../../db/src/__tests__/fixtures/recording-dialect'
import { defineStores } from '../../../db/src/__tests__/fixtures/stores'
import { mintRef, requestCapabilities, RequestFrame, runInRequest } from '../implement/capability'

describe('a Ref chain cannot be changed after authorization', () => {
	test('mutating a resolved chain or the Ref.chain copy leaves the statement on the chain that was checked', async () => {
		const dialect = new RecordingDialect()
		const stores = defineStores({ database: Database.fromDialect(dialect), capabilities: requestCapabilities })
		const frame = new RequestFrame('request-1')
		await runInRequest(frame, async () => {
			const note = mintRef(frame, 'note', 'notes.read', 'user-1', 'n1', new Map([['workspace', 'w1'], ['organization', 'o1']]))
			const grant = requestCapabilities.resolve(note)
			expect(Object.isFrozen(grant)).toBe(true)
			// The note moved to w2 in o2 since it was authorized; the handler tries to follow it without a check.
			if (grant.kind === 'ref' && grant.chain instanceof Map) {
				grant.chain.set('workspace', 'w2').set('organization', 'o2')
			}
			const copy = note.chain
			if (copy instanceof Map) {
				copy.set('workspace', 'w2')
			}
			await stores.notes.get(note).catch(() => null)
		})
		frame.end()
		const parameters = dialect.log.flatMap((statement) => [...statement.parameters])
		expect(parameters).toContain('w1')
		expect(parameters).toContain('o1')
		expect(parameters).not.toContain('w2')
		expect(parameters).not.toContain('o2')
	})

	test('a later resolution returns the chain frozen at mint', async () => {
		const frame = new RequestFrame('request-2')
		await runInRequest(frame, async () => {
			const note = mintRef(frame, 'note', 'notes.read', 'user-1', 'n1', new Map([['workspace', 'w1']]))
			const first = requestCapabilities.resolve(note)
			if (first.kind === 'ref' && first.chain instanceof Map) {
				first.chain.set('workspace', 'w2')
			}
			const second = requestCapabilities.resolve(note)
			expect(second.kind === 'ref' ? Object.fromEntries(second.chain) : null).toEqual({ workspace: 'w1' })
		})
		frame.end()
	})
})
