/**
 * The local composition and a deployed installation must be ONE document with two placements.
 *
 * They used to be two: `prepare.ts` built the local manifest and the live one on `fabrika-test` was
 * hand-written, so the console's access rules could change and reach only one of them — which is what
 * happened, and what nothing reported (backlog 58). `prepare.ts` now calls the installation's
 * generator, and this file pins the consequence: everything except the hostnames, the scheme and IAM's
 * port is identical on both sides, so a table change cannot reach one and miss the other.
 */

import { CONTROL_APP_ID, CONTROL_OPERATIONS_RPC_PATH, CONTROL_RPC_PATH } from '@fabrika/control-contract'
import { controlMcpResource, controlServiceContract, controlServiceDigest } from '@fabrika/control/service'
import { type McpClient, platformServiceTableDigest } from '@fabrika/installation-init'
import { PLATFORM_PROXY_APPS, type PlatformProxyApp, platformProxyManifestTemplate } from '@fabrika/platform-artifacts/proxy-manifest'
import { encodeProxyManifestJson, type InstallationProxyApp, parseProxyManifestJson, serviceProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseOAuthConfig } from '../../../iam/src/oauth-config'
import { DEFAULT_PLATFORM_AUDIENCES } from '../../../iam/src/services'
import { localApps } from '../app-registration'
import {
	localIamOAuthConfig,
	localOperationsOAuthResource,
	localPlatformProxyManifest,
	readLocalMcpAuthoring,
	readLocalOAuthClients,
} from '../prepare'

/** What protects an entry: its service table's rows and reserved prefixes. */
const accessOf = (app: InstallationProxyApp) => ({ endpoints: app.endpoints, reservedPrefixes: app.reservedPrefixes })

/** The table a template entry publishes with an authorization server and no MCP authoring, which is the local default. */
const templateAccessOf = (app: PlatformProxyApp) => {
	const oauth = app.oauth?.table
	const { endpoints, reservedPrefixes } = serviceProxyTable(oauth ?? app.table, { oauth: oauth !== undefined })
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

describe('OAuth and MCP authoring in the local composition', () => {
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
	const consoleOf = (mcp = false) => localPlatformProxyManifest(mcp).apps.find((app) => app.id === CONTROL_APP_ID)
	const tableOf = (mcp: boolean) => serviceProxyTable(controlServiceContract({ mcp, cli: true }), { oauth: true }).endpoints
	const cliResources = (origin: string) => [`${origin}${CONTROL_RPC_PATH}`, `${origin}${CONTROL_OPERATIONS_RPC_PATH}`]

	test('MCP is off by default, while the command-line client is served: its RPC resources are registered with IAM', () => {
		const origin = controlDomain()
		expect(readLocalOAuthClients({})).toBeUndefined()
		expect(readLocalMcpAuthoring({}, undefined)).toEqual({ on: false })
		expect(consoleOf()?.endpoints).toEqual(tableOf(false))
		expect(consoleOf()?.oauthResources?.map((entry) => entry.resource)).toEqual(cliResources(origin))
		const config = parseOAuthConfig(localIamOAuthConfig(undefined, false), DEFAULT_PLATFORM_AUDIENCES)
		expect(config?.clients).toEqual([])
		expect(config?.resources.map((resource) => resource.resource)).toEqual(cliResources(origin))
		// The composition's hosts, which IAM checks an external application registered at runtime against.
		expect(config?.hosts).toEqual(['iam.fabrika.localhost', 'control.fabrika.localhost', 'errors.fabrika.localhost'])
	})

	test('MCP turned on, the console publishes its MCP row for the resource control derives from its own domain', () => {
		const origin = controlDomain()
		expect(consoleOf(true)?.endpoints).toEqual(tableOf(true))
		expect(consoleOf(true)?.oauthResources?.map((entry) => entry.resource)).toEqual([...cliResources(origin), controlMcpResource(origin)])
		for (const entry of consoleOf(true)?.oauthResources ?? []) {
			expect(entry.authorizationServers).toEqual(['http://iam.fabrika.localhost:18080'])
		}
		const manifest = localPlatformProxyManifest(true)
		expect(parseProxyManifestJson(encodeProxyManifestJson(manifest))).toEqual(manifest)
	})

	test('control reads the switch from the same composition: the digest of the table the proxy publishes', () => {
		for (const mcp of [false, true]) {
			const digest = platformServiceTableDigest(localPlatformProxyManifest(mcp), CONTROL_APP_ID)
			expect(digest).toBe(controlServiceDigest({ mcp, cli: true }))
		}
		const compose = readFileSync(resolve(import.meta.dir, '..', '..', 'compose.yaml'), 'utf8')
		expect(compose).toContain('- path: .state/control-table.env')
	})

	test('MCP turned on, IAM gets a config its own parser accepts, for those same resources', () => {
		const origin = controlDomain()
		const config = parseOAuthConfig(localIamOAuthConfig([CLIENT], true), DEFAULT_PLATFORM_AUDIENCES)
		expect(config?.clients.map((client) => client.clientId)).toEqual([CLIENT.clientId])
		expect(config?.resources.map((resource) => [resource.app, resource.resource])).toEqual(
			[...cliResources(origin), controlMcpResource(origin)].map((resource) => ['vozka', resource]),
		)
	})

	test("Operations is told the console's Operations RPC resource, by a file compose reads", () => {
		expect(localOperationsOAuthResource()).toBe(`${controlDomain()}${CONTROL_OPERATIONS_RPC_PATH}`)
		const compose = readFileSync(resolve(import.meta.dir, '..', '..', 'compose.yaml'), 'utf8')
		expect(compose).toContain('- path: .state/operations-oauth.env')
	})

	test('the client list is parsed at the boundary, and its earlier name is refused rather than ignored', () => {
		expect(readLocalOAuthClients({ FABRIKA_LOCAL_OAUTH_CLIENTS_JSON: JSON.stringify([CLIENT]) })).toEqual([CLIENT])
		expect(() => readLocalOAuthClients({ FABRIKA_LOCAL_OAUTH_CLIENTS_JSON: '[]' })).toThrow(/MCP client/)
		expect(() => readLocalOAuthClients({ FABRIKA_LOCAL_MCP_CLIENTS_JSON: JSON.stringify([CLIENT]) })).toThrow(
			'FABRIKA_LOCAL_MCP_CLIENTS_JSON is renamed FABRIKA_LOCAL_OAUTH_CLIENTS_JSON',
		)
	})

	test('the switch decides; unset, an MCP client in the list turns authoring on with a warning; a malformed switch is refused', () => {
		expect(readLocalMcpAuthoring({ FABRIKA_LOCAL_MCP_AUTHORING: 'on' }, undefined)).toEqual({ on: true })
		expect(readLocalMcpAuthoring({ FABRIKA_LOCAL_MCP_AUTHORING: 'off' }, [CLIENT])).toEqual({ on: false })
		const inferred = readLocalMcpAuthoring({}, [CLIENT])
		expect(inferred.on).toBe(true)
		expect(inferred.warning).toContain('set FABRIKA_LOCAL_MCP_AUTHORING=on')
		expect(() => readLocalMcpAuthoring({ FABRIKA_LOCAL_MCP_AUTHORING: 'true' }, undefined)).toThrow('FABRIKA_LOCAL_MCP_AUTHORING must be on or off')
	})
})
