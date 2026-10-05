import { describe, expect, test } from 'bun:test'
import { parseCatalogRequest } from '../catalog.js'
import { parseEventDetail } from '../event-detail.js'
import { buildParsedEvent, parseEventEnvelope } from '../ingest.js'
import { issueCursor, occurrenceCursor } from '../operator-api/pagination.js'
import { alertChannelUpdateInput, issueQuery, mutateIssueInput } from '../operator-rpc-input.js'
import { parseObject } from '../repositories/values.js'

describe('Operations boundary compatibility', () => {
	test('filters malformed telemetry fields individually while retaining raw extensions and exception selection', async () => {
		const payload = {
			message: 'fallback',
			release: 42,
			exception: {
				values: [
					{ type: 'Outer', value: 'outer' },
					{
						type: 7,
						value: 'inner',
						mechanism: { handled: 'no' },
						stacktrace: {
							frames: [
								null,
								4,
								{ filename: 'app.js', lineno: 2, colno: '3', function: false, in_app: true, pre_context: ['ok', 4], context_line: 'throw error' },
							],
						},
					},
				],
			},
			breadcrumbs: { values: [null, 7, { message: 'kept', timestamp: false, category: 9 }] },
			user: { id: 42, email: false },
			request: { url: 4, method: 'POST' },
			context: { url: 'https://example.test/' },
			tags: [['same', 1], ['same', 2], [null, 'ignored'], ['null', null]],
			fingerprint: [7, 'kept', false],
			extension: { unknown: [1, null] },
		}
		const event = buildParsedEvent('source', payload, 100)
		expect(event?.exception).toEqual({
			type: 'Error',
			value: 'inner',
			frames: [{ filename: 'app.js', line: 2, inApp: true, contextLine: 'throw error' }],
		})
		expect(event?.tags).toEqual({ same: '2', null: 'null' })
		expect(event?.sdkFingerprint).toEqual(['kept'])
		expect(event?.raw).toBe(payload)
		expect(event).not.toHaveProperty('release')
		const detail = await parseEventDetail(JSON.stringify(payload), 'source', { get: async () => null })
		expect(detail.exceptions.map(({ type, value, handled }) => ({ type, value, handled }))).toEqual([
			{ type: null, value: 'inner', handled: null },
			{ type: 'Outer', value: 'outer', handled: null },
		])
		expect(detail.breadcrumbs).toEqual([{ message: 'kept' }])
		expect(detail.user).toEqual({ id: '42', email: null, username: null })
		expect(detail.request).toEqual({ url: 'https://example.test/', method: 'POST' })
		expect(detail.tags).toEqual([{ key: 'null', value: 'null' }, { key: 'same', value: '1' }, { key: 'same', value: '2' }])
		expect(detail.rawEvent).toBe(JSON.stringify(payload, null, 2))
	})

	test('keeps opaque event keys and validates envelope lengths without coercion', () => {
		const event = '{"message":"hello","__proto__":{"retained":true},"extension":null}'
		const bytes = new TextEncoder().encode(`{}\n{"type":"event","length":${new TextEncoder().encode(event).length}}\n${event}`)
		expect(JSON.stringify(parseEventEnvelope(bytes).eventPayloads[0])).toBe(event)
		for (const length of ['2', -1, 1.5, null]) {
			expect(() => parseEventEnvelope(new TextEncoder().encode(`{}\n${JSON.stringify({ type: 'event', length })}\n{}`))).toThrow('invalid item length')
		}
	})

	test('normalizes catalog fields and preserves legacy public error categories', () => {
		const source = {
			coordinate: { appId: 'notes', environment: 'prod', serviceKey: undefined, ignored: true },
			displayName: ' Notes ',
			publicOrigin: undefined,
			ingestCredential: { id: '00000000-0000-0000-0000-000000000000', publicKey: 'a'.repeat(32), ignored: true },
			ignored: true,
		}
		const input = { protocolVersion: 2, revision: 1, snapshotHash: 'a'.repeat(64), sources: [source], ignored: true }
		expect(parseCatalogRequest(input)).toEqual({
			protocolVersion: 2,
			revision: 1,
			snapshotHash: 'a'.repeat(64),
			sources: [{
				coordinate: { appId: 'notes', environment: 'prod' },
				displayName: ' Notes ',
				ingestCredential: { id: '00000000-0000-0000-0000-000000000000', publicKey: 'a'.repeat(32) },
			}],
		})
		expect(() => parseCatalogRequest(null)).toThrow('invalid catalog request')
		expect(() => parseCatalogRequest({ ...input, revision: '1' })).toThrow('invalid catalog revision')
		expect(() => parseCatalogRequest({ ...input, sources: [{ ...source, coordinate: null }] })).toThrow('invalid source coordinate')
		expect(() => parseCatalogRequest({ ...input, sources: [{ ...source, publicOrigin: 'https://example.test/' }] })).toThrow('invalid catalog source')
		expect(() => parseCatalogRequest({ ...input, sources: [source, source] })).toThrow('duplicate source coordinate')
	})

	test('strips RPC extensions, omits undefined query fields, and preserves nullable mutations', () => {
		expect(issueQuery.parse({ sourceId: undefined, query: '', cursor: '', ignored: true })).toEqual({ query: '', cursor: '' })
		expect(mutateIssueInput.parse({ issueId: 'issue', mutation: { kind: 'assign', principalId: null, label: 'forged' } })).toEqual({
			issueId: 'issue',
			mutation: { kind: 'assign', principalId: null },
		})
		expect(
			alertChannelUpdateInput.parse({
				sourceId: 'source',
				channelId: 'channel',
				input: { type: 'webhook', scope: 'spike', enabled: true, target: undefined },
			}),
		).toEqual({ sourceId: 'source', channelId: 'channel', input: { type: 'webhook', scope: 'spike', enabled: true } })
		expect(issueQuery.safeParse({ limit: '10' }).success).toBe(false)
		expect(mutateIssueInput.safeParse({ issueId: 'issue', mutation: { kind: 'assign' } }).success).toBe(false)
	})

	test('retains signed cursor values, rejects sort mismatch and keeps stored JSON opaque', () => {
		expect(issueCursor(encodeURIComponent('{"sort":"recent","value":-1,"id":"a","extra":true}'), 'recent')).toEqual({ value: -1, id: 'a' })
		expect(occurrenceCursor(encodeURIComponent('{"receivedAt":0,"id":"a"}'))).toEqual({ receivedAt: 0, id: 'a' })
		for (const value of ['%', '[]', '{"sort":"new","value":1,"id":"a"}', '{"sort":"recent","value":"1","id":"a"}']) {
			expect(() => issueCursor(value, 'recent')).toThrow('invalid cursor')
		}
		expect(parseObject('{"nested":{"unknown":[null,1]},"present":null}')).toEqual({ nested: { unknown: [null, 1] }, present: null })
		expect(() => parseObject('[]')).toThrow('activity data is not an object')
	})
})
