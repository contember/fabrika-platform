// Composing the platform's apps with an installation's application entries.
//
// The case that pays for this file: the live `fabrika-test` proxy manifest carries `notes` →
// `notesapi:3000` beside the three platform apps, because on the light tier an application shares the
// project and therefore the proxy's ONE manifest. Writing the platform template alone would delete it.

import { type InstallationEndpointRow, requirementDigest } from '@fabrika/auth-core'
import {
	type ContractProxyApp,
	contractProxyTable,
	FABRIKA_PROXY_MANIFEST_JSON,
	type InstallationProxyApp,
	type InstallationProxyTable,
	type ProxyApp,
	type ProxyManifest,
} from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../../auth-core/src/__tests__/fixtures/notes-artifact'
import type { ZeropsServiceEnv } from '../../index'
import { mergePlatformProxyManifest, readLiveProxyManifest } from '../manifest'

const protocolRow = (id: string, path: string) => {
	const row: InstallationEndpointRow = { id, kind: 'protocol', method: '*', path, callers: [], requirement: null, admission: null, oauth: null }
	const rules = { ...row, delegation: null }
	return { ...rules, digest: requirementDigest(rules) }
}

const table = (...paths: string[]): InstallationProxyTable => ({
	installation: true,
	endpoints: paths.map((path, index) => protocolRow(`row-${index}`, path)),
	reservedPrefixes: [],
})

const consoleApp: InstallationProxyApp = {
	id: 'vozka',
	hosts: ['proxy-292c-8082.prg1.zerops.app'],
	upstream: 'control:3000',
	scheme: 'https',
	...table('/healthz', '/api'),
}

const platform: ProxyManifest = {
	apps: [
		{ id: 'iam', hosts: ['proxy-292c-8080.prg1.zerops.app'], upstream: 'iam:3000', scheme: 'https', ...table('/*') },
		consoleApp,
		{ id: 'operations', hosts: ['proxy-292c-8083.prg1.zerops.app'], upstream: 'operations:3000', scheme: 'https', ...table('/*') },
	],
}

const notes: ContractProxyApp = {
	id: 'notes',
	hosts: ['proxy-292c-8084.prg1.zerops.app'],
	upstream: 'notesapi:3000',
	scheme: 'https',
	...contractProxyTable(notesArtifact),
}

describe('merging', () => {
	test('carries every application entry the platform does not own', () => {
		const merged = mergePlatformProxyManifest(platform, { apps: [...platform.apps, notes] })
		expect(merged.manifest.apps.map((app) => app.id)).toEqual(['iam', 'vozka', 'operations', 'notes'])
		expect(merged.carried).toEqual(['notes'])
		expect(merged.manifest.apps.find((app) => app.id === 'notes')).toEqual(notes)
	})

	test('replaces a platform app rather than duplicating it, and its table wins', () => {
		// The drift backlog 58 exists for: the live console entry made everything `public` while the
		// console's own declaration had said otherwise for two days.
		const stale: InstallationProxyApp = { ...consoleApp, ...table('/*') }
		const merged = mergePlatformProxyManifest(platform, { apps: [stale, notes] })
		expect(merged.manifest.apps.filter((app) => app.id === 'vozka')).toHaveLength(1)
		expect(merged.manifest.apps.find((app) => app.id === 'vozka')).toMatchObject({ endpoints: consoleApp.endpoints })
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
	const readable = (content: string): ZeropsServiceEnv => ({ id: 'env-1', key: FABRIKA_PROXY_MANIFEST_JSON, sensitive: false, content })

	test('absent or empty means no manifest yet', () => {
		expect(readLiveProxyManifest(undefined)).toBeNull()
		expect(readLiveProxyManifest(readable('   '))).toBeNull()
	})

	test('unparseable is refused, because the entries it holds cannot be read and must not be dropped', () => {
		expect(() => readLiveProxyManifest(readable('{"apps":[{"id":"notes"}]}'))).toThrow('cannot be parsed by this build')
		expect(() => readLiveProxyManifest(readable('not json'))).toThrow('cannot be parsed by this build')
	})

	test('a sensitive one is refused too, naming why: Zerops hands back no value to merge', () => {
		const sensitive: ZeropsServiceEnv = { id: 'env-1', key: FABRIKA_PROXY_MANIFEST_JSON, sensitive: true }
		expect(() => readLiveProxyManifest(sensitive)).toThrow('stored as a SENSITIVE variable')
	})
})
