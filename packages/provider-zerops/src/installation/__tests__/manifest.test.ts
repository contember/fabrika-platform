// Composing the platform's apps with an installation's application entries.
//
// The case that pays for this file: the live `fabrika-test` proxy manifest carries `notes` →
// `notesapi:3000` beside the three platform apps, because on the light tier an application shares the
// project and therefore the proxy's ONE manifest. Writing the platform template alone would delete it.

import type { ProxyApp, ProxyManifest } from '@fabrika/proxy-contract'
import { describe, expect, test } from 'bun:test'
import { mergePlatformProxyManifest, readLiveProxyManifest } from '../manifest'

const gates = { rules: [{ path: '/*', kind: 'public' } as const] }

const consoleApp: ProxyApp = {
	id: 'vozka',
	hosts: ['proxy-292c-8082.prg1.zerops.app'],
	upstream: 'control:3000',
	gates: { rules: [{ path: '/api/*', kind: 'human' }, { path: '/healthz', kind: 'public' }] },
	scheme: 'https',
}

const platform: ProxyManifest = {
	apps: [
		{ id: 'iam', hosts: ['proxy-292c-8080.prg1.zerops.app'], upstream: 'iam:3000', gates, scheme: 'https' },
		consoleApp,
		{ id: 'operations', hosts: ['proxy-292c-8083.prg1.zerops.app'], upstream: 'operations:3000', gates, scheme: 'https' },
	],
}

const notes: ProxyApp = { id: 'notes', hosts: ['proxy-292c-8084.prg1.zerops.app'], upstream: 'notesapi:3000', gates, scheme: 'https' }

describe('merging', () => {
	test('carries every application entry the platform does not own', () => {
		const merged = mergePlatformProxyManifest(platform, { apps: [...platform.apps, notes] })
		expect(merged.manifest.apps.map((app) => app.id)).toEqual(['iam', 'vozka', 'operations', 'notes'])
		expect(merged.carried).toEqual(['notes'])
		expect(merged.manifest.apps.find((app) => app.id === 'notes')).toEqual(notes)
	})

	test('replaces a platform app rather than duplicating it, and its gates win', () => {
		// The drift backlog 58 exists for: the live console entry gated everything `public` while
		// `CONTROL_PROXY_GATES` had said otherwise for two days.
		const stale: ProxyApp = { ...consoleApp, gates }
		const merged = mergePlatformProxyManifest(platform, { apps: [stale, notes] })
		expect(merged.manifest.apps.filter((app) => app.id === 'vozka')).toHaveLength(1)
		expect(merged.manifest.apps.find((app) => app.id === 'vozka')?.gates).toEqual(consoleApp.gates)
	})

	test('supersedes a live entry standing on a platform host, and reports which one', () => {
		// The live `iam-local`: WU1 corrected IAM's app id, so the live document names the platform's own
		// IAM host under an id the platform no longer uses. Carrying it would produce a manifest
		// `parseProxyManifest` rejects — two apps, one host.
		const legacy: ProxyApp = { ...notes, id: 'iam-local', hosts: ['proxy-292c-8080.prg1.zerops.app'], upstream: 'iam:3000' }
		const merged = mergePlatformProxyManifest(platform, { apps: [legacy, notes] })
		expect(merged.manifest.apps.map((app) => app.id)).toEqual(['iam', 'vozka', 'operations', 'notes'])
		expect(merged.superseded).toEqual([{ id: 'iam-local', host: 'proxy-292c-8080.prg1.zerops.app' }])
	})

	test('a live manifest with no application entries composes to the platform document alone', () => {
		expect(mergePlatformProxyManifest(platform, null).manifest).toEqual(platform)
		expect(mergePlatformProxyManifest(platform, null).carried).toEqual([])
	})

	test('refuses two APPLICATION entries claiming one host, which it cannot resolve', () => {
		const twin: ProxyApp = { ...notes, id: 'notes-twin' }
		expect(() => mergePlatformProxyManifest(platform, { apps: [notes, twin] })).toThrow('two application entries claim one host')
	})

	test('is byte-stable: composing an already-composed manifest changes nothing', () => {
		const once = mergePlatformProxyManifest(platform, { apps: [...platform.apps, notes] })
		const twice = mergePlatformProxyManifest(platform, once.manifest)
		expect(JSON.stringify(twice.manifest)).toBe(JSON.stringify(once.manifest))
	})
})

describe('reading the live value', () => {
	test('absent or empty means no manifest yet', () => {
		expect(readLiveProxyManifest(undefined)).toBeNull()
		expect(readLiveProxyManifest('   ')).toBeNull()
	})

	test('unparseable is refused, because the entries it holds cannot be read and must not be dropped', () => {
		expect(() => readLiveProxyManifest('{"apps":[{"id":"notes"}]}')).toThrow('cannot be parsed by this build')
		expect(() => readLiveProxyManifest('not json')).toThrow('cannot be parsed by this build')
	})
})
