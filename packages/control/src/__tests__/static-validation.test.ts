import { describe, expect, test } from 'bun:test'
import { readProviderEnvelope } from '../api/provider-envelope'
import { decodeControlJobMessage, decodeDeployJobMessage } from '../consumer'
import { parseProviderJson, serializeProviderJson } from '../db/runs'
import { parseBootstrapAdmins } from '../iam'
import { decodePushEvent } from '../repo-source'
import { parseProviderEnvelope } from '../run-lifecycle'

describe('Control boundary compatibility', () => {
	test('API and lifecycle envelope acceptance remain distinct', () => {
		expect(readProviderEnvelope({ provider: '', version: 1, payload: null, extra: true })).toEqual({ provider: '', version: 1, payload: null })
		expect(readProviderEnvelope({ provider: 'test', version: 0, payload: null })).toBeNull()
		expect(parseProviderEnvelope('{"provider":"test","version":0,"payload":null,"extra":true}', 'target')).toEqual({
			provider: 'test',
			version: 0,
			payload: null,
		})
		expect(() => parseProviderEnvelope('{"provider":"","version":1,"payload":null}', 'target')).toThrow('target is not a provider envelope')
		expect(() => parseProviderEnvelope('{', 'target')).toThrow('target is not valid JSON')
		expect(readProviderEnvelope({ provider: 'test', version: 1 })).toBeNull()
	})

	test('checkpoint keys, ordering, shared references and finite-number rejection survive parsing', () => {
		const raw = '{"z":1,"__proto__":{"kept":true},"a":[null,false,"x"]}'
		expect(serializeProviderJson(parseProviderJson(raw, 'checkpoint'))).toBe(raw)
		const shared = { value: 1 }
		expect(serializeProviderJson({ first: shared, second: shared })).toBe('{"first":{"value":1},"second":{"value":1}}')
		expect(() => parseProviderJson('1e400', 'checkpoint')).toThrow('checkpoint is not a JSON value')
		expect(() => serializeProviderJson({ value: Number.NaN })).toThrow('provider checkpoint is not a JSON value')
	})

	test('queue compatibility filters optional values without changing discriminators', () => {
		expect(decodeControlJobMessage({ runId: 'run', dryRun: 'true', ignored: 1 })).toEqual({ runId: 'run' })
		expect(decodeDeployJobMessage({ runId: 'run', dryRun: true })).toEqual({ runId: 'run', dryRun: true })
		expect(decodeControlJobMessage({ kind: 'namespace', namespaceId: 'ns', mutation: 'reconcile', ignored: 1 })).toEqual({
			kind: 'namespace',
			namespaceId: 'ns',
			mutation: 'reconcile',
		})
		expect(() => decodeControlJobMessage({ kind: 'deploy', runId: 'run' })).toThrow('control job payload has an unknown kind')
		expect(() => decodeControlJobMessage({ kind: 'namespace', namespaceId: '', mutation: 'bad' })).toThrow('namespace job payload has no namespaceId')
	})

	test('verified webhook optional fields keep fallback and filtering behavior', () => {
		expect(decodePushEvent({ ref: '', repository: { clone_url: 123, html_url: 'fallback' }, after: 42, installation: { id: -1 } })).toEqual({
			ref: '',
			repoUrl: 'fallback',
			commitSha: null,
			installationId: null,
		})
		expect(decodePushEvent({ ref: 'refs/heads/main', repository: { clone_url: 'clone', html_url: 'html' }, after: 'ABC', installation: { id: 12 } }))
			.toEqual({
				ref: 'refs/heads/main',
				repoUrl: 'clone',
				commitSha: 'ABC',
				installationId: 12,
			})
		expect(decodePushEvent({ ref: 1, repository: { clone_url: 'clone' } })).toBeNull()
	})

	test('bootstrap list filters individual non-strings and deduplicates emails', () => {
		expect([...parseBootstrapAdmins('["a",null,2,"","a"]')]).toEqual(['a', ''])
		expect([...parseBootstrapAdmins('{"email":"a"}')]).toEqual([])
	})
})
