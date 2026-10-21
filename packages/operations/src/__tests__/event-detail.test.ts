import { describe, expect, test } from 'bun:test'
import { parseEventDetail } from '../event-detail.js'
import type { ObjectReader } from '../source-maps.js'
import { resolveFrames, sourceMapKey } from '../source-maps.js'

const map = JSON.stringify({
	version: 3,
	file: 'app.min.js',
	sourceRoot: '',
	sources: ['src/app.ts'],
	sourcesContent: [
		[
			'export function renderUserCard(user) {',
			'\treturn user.profile.x',
			'}',
		].join('\n'),
	],
	names: ['renderUserCard', 'user', 'profile', 'x'],
	mappings: 'AAAA,SAASA,cAAcC,GAAQ,OAAOA,EAAKC,QAAQC,CAAE',
})

function reader(objects: Record<string, string>): ObjectReader {
	return {
		async get(key) {
			const value = objects[key]
			return value === undefined ? null : {
				async text() {
					return value
				},
			}
		},
	}
}

describe('event detail and source context', () => {
	test('resolves a source map and gracefully falls back when absent', async () => {
		const key = sourceMapKey('source-a', 'v1.2.3', 'https://app.test/app.min.js?v=1')
		const frames = [{
			filename: 'https://app.test/app.min.js?v=1',
			function: 't',
			line: 1,
			column: 1,
			inApp: true,
		}]
		const resolved = await resolveFrames(frames, 'source-a', 'v1.2.3', reader({ [key]: map }))
		expect(resolved[0]?.resolved).toBeTrue()
		expect(resolved[0]?.file).toBe('src/app.ts')
		const fallback = await resolveFrames(frames, 'source-a', 'missing', reader({}))
		expect(fallback[0]).toMatchObject({ resolved: false, function: 't', line: 1, column: 1 })
	})

	test('keeps exception order, embedded context, request and actor details', async () => {
		const raw = JSON.stringify({
			event_id: 'evt-1',
			platform: 'node',
			release: 'v2',
			environment: 'production',
			server_name: 'api-1',
			tags: { region: 'eu', build: 17 },
			request: { url: 'https://api.test/orders', method: 'POST' },
			user: { id: 42, email: 'dev@example.test' },
			breadcrumbs: { values: [{ category: 'http', message: 'POST /orders' }] },
			contexts: {
				runtime: { name: 'Bun', version: '1.3' },
				os: { name: 'Linux' },
				trace: { trace_id: 'trace-1' },
			},
			exception: {
				values: [
					{ type: 'SocketError', value: 'refused', stacktrace: { frames: [] } },
					{
						type: 'UpstreamError',
						value: 'timeout',
						mechanism: { handled: false },
						stacktrace: {
							frames: [{
								filename: 'src/gateway.ts',
								function: 'call',
								lineno: 42,
								colno: 5,
								in_app: true,
								pre_context: ['before'],
								context_line: 'throw error',
								post_context: ['after'],
							}],
						},
					},
				],
			},
		})
		const detail = await parseEventDetail(raw, 'source-a', reader({}))
		expect(detail.exceptions.map((exception) => exception.type)).toEqual(['UpstreamError', 'SocketError'])
		expect(detail.exceptions[0]?.handled).toBeFalse()
		expect(detail.exceptions[0]?.frames[0]?.source).toEqual({
			lines: ['before', 'throw error', 'after'],
			errorIndex: 1,
			startLine: 41,
		})
		expect(detail.request).toEqual({ url: 'https://api.test/orders', method: 'POST' })
		expect(detail.user).toEqual({ id: '42', email: 'dev@example.test', username: null })
		expect(detail.runtime).toBe('Bun 1.3')
		expect(detail.traceId).toBe('trace-1')
	})

	test('reads tags as a record or as key/value pairs, and tolerates malformed fields', async () => {
		const fromRecord = await parseEventDetail(JSON.stringify({ tags: { region: 'eu', build: 17, empty: null } }), 'source-a', reader({}))
		expect(fromRecord.tags).toEqual([{ key: 'build', value: '17' }, { key: 'region', value: 'eu' }])
		const fromPairs = await parseEventDetail(
			JSON.stringify({ tags: [['region', 'eu'], ['build', 17], ['broken'], 'loose', [null, 'x']], user: 'nobody', breadcrumbs: 3, contexts: [] }),
			'source-a',
			reader({}),
		)
		expect(fromPairs.tags).toEqual([{ key: 'build', value: '17' }, { key: 'region', value: 'eu' }])
		expect(fromPairs.user).toBeNull()
		expect(fromPairs.breadcrumbs).toEqual([])
		expect(fromPairs.runtime).toBeNull()
	})

	test('loads a map once for every exception of one event', async () => {
		const loads: string[] = []
		const countingReader: ObjectReader = {
			async get() {
				return null
			},
			async getSourceMap(_sourceId, _releaseName, logicalPath) {
				loads.push(logicalPath)
				return {
					async text() {
						return map
					},
				}
			},
		}
		const stack = { frames: [{ abs_path: 'https://app.test/app.min.js', function: 't', lineno: 1, colno: 1 }] }
		const raw = JSON.stringify({
			release: 'v1',
			exception: { values: [{ type: 'Cause', stacktrace: stack }, { type: 'Wrapper', stacktrace: stack }] },
		})
		const detail = await parseEventDetail(raw, 'source-a', countingReader)
		expect(detail.exceptions.map((exception) => exception.frames[0]?.file)).toEqual(['src/app.ts', 'src/app.ts'])
		expect(loads).toEqual(['app.min.js'])
	})

	test('retains malformed event bytes for forensics', async () => {
		const detail = await parseEventDetail('{broken', 'source-a', reader({}))
		expect(detail.rawEvent).toBe('{broken')
		expect(detail.exceptions).toEqual([])
	})
})
