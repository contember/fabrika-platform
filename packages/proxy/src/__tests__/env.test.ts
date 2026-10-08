/**
 * Boot configuration. Refusing to boot beats booting misconfigured: a proxy missing its IAM
 * coordinates would 503 every request instead of failing where an operator can see it.
 */

import { proxySecretVariable } from '@fabrika/auth-core'
import type { ContractProxyApp, ProxyApp } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { appsWithoutProxySecret, ProxyEnvError, readProxyEnv } from '../env'

describe('readProxyEnv', () => {
	/** Everything required, so each test varies exactly the one variable it is about. */
	const env = (overrides: Record<string, string | undefined> = {}) => ({
		FABRIKA_IAM_ISSUER: 'https://iam.test',
		FABRIKA_IAM_KEY: 'px_proxy',
		...overrides,
	})

	test('requires the IAM url — refusing to boot beats booting misconfigured', () => {
		expect(() => readProxyEnv({})).toThrow(ProxyEnvError)
		expect(() => readProxyEnv(env({ FABRIKA_IAM_ISSUER: '' }))).toThrow(ProxyEnvError)
	})

	test('requires the IAM key: without it every mint 404s, so the proxy would 503 everything', () => {
		expect(() => readProxyEnv({ FABRIKA_IAM_ISSUER: 'https://iam.test' })).toThrow(ProxyEnvError)
		expect(() => readProxyEnv(env({ FABRIKA_IAM_KEY: '' }))).toThrow(ProxyEnvError)
	})

	test('the IAM url is canonicalized to an origin, because `iss` is compared byte for byte', () => {
		expect(readProxyEnv(env({ FABRIKA_IAM_ISSUER: 'https://iam.test/' })).iamUrl).toBe('https://iam.test')
		expect(readProxyEnv(env({ FABRIKA_IAM_ISSUER: 'https://iam.test' })).iamUrl).toBe('https://iam.test')
		expect(readProxyEnv(env({ FABRIKA_IAM_ISSUER: 'https://iam.test:8443/auth/' })).iamUrl).toBe('https://iam.test:8443')
	})

	test('an IAM url that is not an absolute http(s) URL refuses to boot', () => {
		expect(() => readProxyEnv(env({ FABRIKA_IAM_ISSUER: 'iam.test' }))).toThrow(ProxyEnvError)
		expect(() => readProxyEnv(env({ FABRIKA_IAM_ISSUER: 'ftp://iam.test' }))).toThrow(ProxyEnvError)
	})

	test('caches by default, and only an explicit off disables it', () => {
		expect(readProxyEnv(env()).cacheEnabled).toBe(true)
		expect(readProxyEnv(env({ FABRIKA_PROXY_CACHE: 'off' })).cacheEnabled).toBe(false)
		// A typo must not silently change behaviour in either direction.
		expect(readProxyEnv(env({ FABRIKA_PROXY_CACHE: 'OFF' })).cacheEnabled).toBe(true)
	})

	test('a nonsense port or timeout falls back to the default rather than to zero', () => {
		const parsed = readProxyEnv(env({ FABRIKA_PROXY_PORT: 'abc', FABRIKA_IAM_TIMEOUT_MS: '-1' }))
		expect(parsed.port).toBe(9000)
		expect(parsed.iamTimeoutMs).toBeGreaterThan(0)
	})
})

describe('appsWithoutProxySecret', () => {
	const contract = (id: string): ContractProxyApp => ({
		id,
		hosts: [`${id.replace('@', '-')}.example.com`],
		upstream: 'app:3000',
		scheme: 'https',
		endpoints: [],
		reservedPrefixes: [],
		snapshot: `sha256:${'0'.repeat(64)}`,
	})
	const gateApp: ProxyApp = { id: 'control', hosts: ['control.example.com'], upstream: 'control:3000', scheme: 'https', gates: { rules: [] } }

	test('names each contract app whose secret variable is unset or empty, and no gate app', () => {
		const manifest = { apps: [contract('notes@prod'), contract('notes@stage'), contract('wiki@prod'), gateApp] }
		const source = { [proxySecretVariable('notes@prod')]: 'secret', [proxySecretVariable('notes@stage')]: '' }
		expect(appsWithoutProxySecret(manifest, source)).toEqual(['notes@stage', 'wiki@prod'])
	})
})
