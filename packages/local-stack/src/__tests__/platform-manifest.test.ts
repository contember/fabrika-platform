/**
 * The local composition and a deployed installation must be ONE document with two placements.
 *
 * They used to be two: `prepare.ts` built the local manifest and the live one on `fabrika-test` was
 * hand-written, so `CONTROL_PROXY_GATES` could change and reach only one of them — which is what
 * happened, and what nothing reported (backlog 58). `prepare.ts` now calls the installation's
 * generator, and this file pins the consequence: everything except the hostnames, the scheme and IAM's
 * port is identical on both sides, so a gate change cannot reach one and miss the other.
 */

import { controlMcpResource, controlProxyGates } from '@fabrika/control/gates'
import { PLATFORM_PROXY_APPS, type PlatformProxyApp, platformProxyManifestTemplate } from '@fabrika/platform-artifacts/proxy-manifest'
import type { McpClient } from '@fabrika/provider-zerops/installation'
import {
	encodeProxyManifestJson,
	type InstallationServiceApp,
	isGateProxyApp,
	parseProxyManifestJson,
	serviceProxyTable,
} from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseOAuthConfig } from '../../../iam/src/oauth-config'
import { localApps } from '../app-registration'
import { localIamOAuthConfig, localPlatformProxyManifest, readLocalMcpClients } from '../prepare'

/** What protects an entry: its gates, or its service table's rows and reserved prefixes. */
const accessOf = (app: InstallationServiceApp) =>
	isGateProxyApp(app) ? app.gates : { endpoints: app.endpoints, reservedPrefixes: app.reservedPrefixes }

const templateAccessOf = (app: PlatformProxyApp) => {
	if (app.table === undefined) return app.gates
	const { endpoints, reservedPrefixes } = serviceProxyTable(app.table, { oauth: false })
	return { endpoints, reservedPrefixes }
}

describe('the local platform manifest is the installation template, placed locally', () => {
	test('the same apps in the same order, with the same gates or service tables', () => {
		const local = localPlatformProxyManifest().apps
		expect(local.map((app) => app.id)).toEqual(PLATFORM_PROXY_APPS.map((app) => app.id))
		expect(local.map(accessOf)).toEqual(PLATFORM_PROXY_APPS.map(templateAccessOf))
	})

	test('and nothing beside them — an app the local stack alone fronts would be a definition of its own', () => {
		expect(localPlatformProxyManifest().apps).toHaveLength(platformProxyManifestTemplate().apps.length)
	})

	test('only the composition-owned fields differ: every host is local and every scheme is plain HTTP', () => {
		for (const app of localPlatformProxyManifest().apps) {
			expect(app.scheme).toBe('http')
			expect(app.hosts.every((host) => host.endsWith('.fabrika.localhost'))).toBe(true)
		}
	})

	test('the upstreams are the installation ones except IAM, which the composition publishes on 18080', () => {
		const byId = new Map(localPlatformProxyManifest().apps.map((app) => [app.id, app.upstream]))
		for (const app of PLATFORM_PROXY_APPS) {
			const expected = app.service === 'iam' ? 'iam:18080' : app.upstream
			expect(byId.get(app.id)).toBe(expected)
		}
	})
})

describe('what the local composition registers with IAM', () => {
	test('every registered app is one the platform proxy fronts, at a host it fronts it on', () => {
		const fronted = new Map(localPlatformProxyManifest().apps.map((app) => [app.id, app.hosts]))
		for (const app of localApps) {
			const hosts = fronted.get(app.id)
			// `notes` is fronted by the OTHER local proxy, so absence here is not a failure; a registered
			// origin that names a host the platform proxy does NOT serve would be.
			if (hosts === undefined) continue
			expect(app.returnOrigins.map((origin) => new URL(origin).hostname)).toEqual(hosts)
		}
	})
})

describe('MCP authoring in the local composition', () => {
	const CLIENT: McpClient = {
		provider: 'claude',
		clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
		redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
	}
	// What control derives its MCP resource from: its `FABRIKA_CONTROL_DOMAIN` in compose.yaml.
	const controlDomain = (): string => {
		const compose = readFileSync(resolve(import.meta.dir, '..', '..', 'compose.yaml'), 'utf8')
		const match = /FABRIKA_CONTROL_DOMAIN: (\S+)/.exec(compose)
		if (match?.[1] === undefined) throw new Error('compose.yaml names no FABRIKA_CONTROL_DOMAIN')
		return match[1]
	}
	const consoleOf = (clients?: readonly McpClient[]) => {
		const console_ = localPlatformProxyManifest(clients).apps.find((app) => app.id === 'vozka')
		return console_ !== undefined && isGateProxyApp(console_) ? console_ : undefined
	}

	test('is off by default: no OAuth gate, no registered resource, and IAM OAuth disabled', () => {
		expect(readLocalMcpClients({})).toBeUndefined()
		expect(consoleOf()?.gates).toEqual(controlProxyGates())
		expect(consoleOf()?.oauthResources).toBeUndefined()
		expect(localIamOAuthConfig(undefined)).toBe('')
	})

	test('turned on, the console is gated for the resource control derives from its own domain', () => {
		const origin = controlDomain()
		expect(consoleOf([CLIENT])?.gates).toEqual(controlProxyGates(origin))
		expect(consoleOf([CLIENT])?.oauthResources?.map((entry) => entry.resource)).toEqual([controlMcpResource(origin)])
		expect(consoleOf([CLIENT])?.oauthResources?.[0]?.authorizationServers).toEqual(['http://iam.fabrika.localhost:18080'])
		const manifest = localPlatformProxyManifest([CLIENT])
		expect(parseProxyManifestJson(encodeProxyManifestJson(manifest))).toEqual(manifest)
	})

	test('turned on, IAM gets a config its own parser accepts, for that same resource', () => {
		const config = parseOAuthConfig(localIamOAuthConfig([CLIENT]))
		expect(config?.clients.map((client) => client.clientId)).toEqual([CLIENT.clientId])
		expect(config?.resources.map((resource) => [resource.app, resource.resource])).toEqual([['vozka', controlMcpResource(controlDomain())]])
	})

	test('the opt-in variable is parsed at the boundary', () => {
		expect(readLocalMcpClients({ FABRIKA_LOCAL_MCP_CLIENTS_JSON: JSON.stringify([CLIENT]) })).toEqual([CLIENT])
		expect(() => readLocalMcpClients({ FABRIKA_LOCAL_MCP_CLIENTS_JSON: '[]' })).toThrow(/MCP client/)
	})
})
