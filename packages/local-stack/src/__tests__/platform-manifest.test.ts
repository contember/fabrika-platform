/**
 * The local composition and a deployed installation must be ONE document with two placements.
 *
 * They used to be two: `prepare.ts` built the local manifest and the live one on `fabrika-test` was
 * hand-written, so the console's gates could change and reach only one of them — which is what
 * happened, and what nothing reported (backlog 58). `prepare.ts` now calls the installation's
 * generator, and this file pins the consequence: everything except the hostnames, the scheme and IAM's
 * port is identical on both sides, so a table change cannot reach one and miss the other.
 */

import { controlMcpResource, controlServiceContract, controlServiceDigest } from '@fabrika/control/service'
import {
	PLATFORM_CONSOLE_APP_ID,
	PLATFORM_PROXY_APPS,
	type PlatformProxyApp,
	platformProxyManifestTemplate,
} from '@fabrika/platform-artifacts/proxy-manifest'
import { type McpClient, platformServiceTableDigest } from '@fabrika/provider-zerops/installation'
import { encodeProxyManifestJson, type InstallationProxyApp, parseProxyManifestJson, serviceProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseOAuthConfig } from '../../../iam/src/oauth-config'
import { localApps } from '../app-registration'
import { localIamOAuthConfig, localPlatformProxyManifest, readLocalMcpClients } from '../prepare'

/** What protects an entry: its service table's rows and reserved prefixes. */
const accessOf = (app: InstallationProxyApp) => ({ endpoints: app.endpoints, reservedPrefixes: app.reservedPrefixes })

/** The table a template entry publishes with no authorization server, which is the local default. */
const templateAccessOf = (app: PlatformProxyApp) => {
	const { endpoints, reservedPrefixes } = serviceProxyTable(app.tableWithoutOAuth ?? app.table, { oauth: false })
	return { endpoints, reservedPrefixes }
}

describe('the local platform manifest is the installation template, placed locally', () => {
	test('the same apps in the same order, with the same service tables', () => {
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
	const consoleOf = (clients?: readonly McpClient[]) => localPlatformProxyManifest(clients).apps.find((app) => app.id === PLATFORM_CONSOLE_APP_ID)
	const tableOf = (mcp: boolean) => serviceProxyTable(controlServiceContract({ mcp }), { oauth: mcp }).endpoints

	test('is off by default: no OAuth row, no registered resource, and IAM OAuth disabled', () => {
		expect(readLocalMcpClients({})).toBeUndefined()
		expect(consoleOf()?.endpoints).toEqual(tableOf(false))
		expect(consoleOf()?.oauthResources).toBeUndefined()
		expect(localIamOAuthConfig(undefined)).toBe('')
	})

	test('turned on, the console publishes its OAuth row for the resource control derives from its own domain', () => {
		const origin = controlDomain()
		expect(consoleOf([CLIENT])?.endpoints).toEqual(tableOf(true))
		expect(consoleOf([CLIENT])?.oauthResources?.map((entry) => entry.resource)).toEqual([controlMcpResource(origin)])
		expect(consoleOf([CLIENT])?.oauthResources?.[0]?.authorizationServers).toEqual(['http://iam.fabrika.localhost:18080'])
		const manifest = localPlatformProxyManifest([CLIENT])
		expect(parseProxyManifestJson(encodeProxyManifestJson(manifest))).toEqual(manifest)
	})

	test('control reads the switch from the same composition: the digest of the table the proxy publishes', () => {
		for (const clients of [undefined, [CLIENT]]) {
			const digest = platformServiceTableDigest(localPlatformProxyManifest(clients), PLATFORM_CONSOLE_APP_ID)
			expect(digest).toBe(controlServiceDigest({ mcp: clients !== undefined }))
		}
		const compose = readFileSync(resolve(import.meta.dir, '..', '..', 'compose.yaml'), 'utf8')
		expect(compose).toContain('- path: .state/control-table.env')
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
