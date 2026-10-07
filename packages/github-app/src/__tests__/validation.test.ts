import { describe, expect, test } from 'bun:test'
import { decodeAppIdentity, decodeWebhookConfig } from '../validation'

const identity = {
	id: 123,
	slug: 'source-app',
	html_url: 'https://github.com/apps/source-app',
	permissions: { contents: 'read' },
	events: ['installation', 'push', 'push'],
	owner: { login: 'example', type: 'Organization' },
}

describe('GitHub response projection compatibility', () => {
	test.each([{}, { metadata: undefined }, { metadata: 'read' }])('accepts optional metadata permission %j without returning it', (metadata) => {
		expect(decodeAppIdentity({
			...identity,
			permissions: { ...identity.permissions, ...metadata },
			owner: { ...identity.owner, avatar_url: 'ignored' },
			client_secret: 'never-return',
		})).toEqual({
			id: 123,
			slug: 'source-app',
			htmlUrl: 'https://github.com/apps/source-app',
			permissions: { contents: 'read' },
			events: ['installation', 'push', 'push'],
			owner: { login: 'example', type: 'Organization' },
		})
	})

	test.each([
		{ permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' }, expected: { contents: 'write', pull_requests: 'write' } },
		{ permissions: { contents: 'write' }, expected: { contents: 'write' } },
		{ permissions: { contents: 'read', pull_requests: 'read' }, expected: { contents: 'read', pull_requests: 'read' } },
	])('accepts repository write authority $permissions', ({ permissions, expected }) => {
		expect(decodeAppIdentity({ ...identity, permissions })?.permissions).toEqual(expected)
	})

	test.each([
		{ permissions: { contents: 'read', metadata: null } },
		{ permissions: { contents: 'write', administration: 'write' } },
		{ permissions: { contents: 'write', workflows: 'write' } },
		{ permissions: { contents: 'admin' } },
		{ permissions: { contents: 'read', unknown: undefined } },
		{ id: Number.MAX_SAFE_INTEGER + 1 },
		{ events: ['push', null] },
		{ owner: { login: 'example', type: 'Bot' } },
		{ html_url: 'https://github.com/apps/another-app' },
	])('rejects malformed or unbound identity %j', (override) => {
		expect(decodeAppIdentity({ ...identity, ...override })).toBeNull()
	})

	test.each([
		{ input: 0, expected: '0' },
		{ input: '0', expected: '0' },
		{ input: 1, expected: '1' },
		{ input: '1', expected: '1' },
	])('normalizes webhook TLS flag $input and drops secret fields', ({ input, expected }) => {
		expect(decodeWebhookConfig({ url: 'https://example.test/hook', content_type: 'form', insecure_ssl: input, secret: 'never-return' })).toEqual({
			url: 'https://example.test/hook',
			contentType: 'form',
			insecureSsl: expected,
		})
	})

	test.each([undefined, null, false, 2, 'false'])('rejects webhook TLS flag %j', (insecure_ssl) => {
		expect(decodeWebhookConfig({ url: 'https://example.test/hook', content_type: 'json', insecure_ssl })).toBeNull()
	})

	test('refuses noncanonical webhook URLs rather than rewriting them', () => {
		expect(decodeWebhookConfig({ url: 'https://EXAMPLE.test/hook', content_type: 'json', insecure_ssl: '0' })).toBeNull()
	})
})
