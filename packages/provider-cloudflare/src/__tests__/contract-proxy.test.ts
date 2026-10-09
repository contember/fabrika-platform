/**
 * A contract application behind the proxy Worker the Cloudflare deployer builds from the contract's endpoint table
 * (ADR-0048): each request goes through the proxy's per-endpoint decision into `boot`'s real pipeline, with no harness
 * adding the endpoint header on the way.
 */

import { compileContract } from '@fabrika/app/contract'
import { boot } from '@fabrika/app/implement'
import { type AppEnvironment, type MintFromKeyResult, type MintTokenResult, parseAppEnvironmentId, type PermissionEntry } from '@fabrika/auth-core'
import { silentLogger } from '@fabrika/proxy-core'
import { contractProxyTable, parseProxyManifestJson } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { Worker } from 'oblaka-iac'
import { notesApp } from '../../../app/src/__tests__/fixtures/implement/app'
import { contract } from '../../../app/src/__tests__/fixtures/implement/fabrika.contract'
import {
	APP_ID,
	echoAssets,
	environment,
	frameworkEnvFor,
	grant,
	ISSUER,
	keySource,
	token,
	type TokenKind,
} from '../../../app/src/__tests__/fixtures/implement/harness'
import { NOTE_TABLE } from '../../../app/src/__tests__/fixtures/implement/stores'
import { FakeIam } from '../../../proxy-core/src/__tests__/helpers'
import { createCloudflareDeployer, defineApp, generateWranglerConfigs } from '..'
import { createCloudflareProxyWorker } from '../proxy'
import { createCloudflareProxyHandler } from '../proxy-worker'

const HOST = 'notes.example.com'
const artifact = compileContract(contract, { notes: NOTE_TABLE })
const table = contractProxyTable(artifact)
const deploymentOf = (id: string): AppEnvironment => {
	const parsed = parseAppEnvironmentId(id)
	if (parsed === null) throw new Error(`${id} is not <app>@<env>`)
	return parsed
}
const deployment = deploymentOf(APP_ID)

const appWorker = (): Worker =>
	new Worker({
		dir: '.',
		name: 'notes-app',
		main: './src/index.ts',
		compatibility_flags: [],
		bindings: {},
		workers_dev: false,
		preview_urls: false,
		routes: [],
	})

/** The root Worker the deployer hands oblaka for the contract application whose config returns only `notes-app`. */
async function deployedProxy(): Promise<Worker> {
	const provisioned: Worker[] = []
	const config = defineApp({ id: deployment.app, schema: { scopes: [], actions: [], roles: {}, contract: true }, resources: appWorker })
	const result = await createCloudflareDeployer({
		accountId: 'account',
		apiToken: 'token',
		collaborators: {
			loadConfig: async () => ({ config, cwd: '/checkout' }),
			readContract: async () => artifact,
			runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			provision: async (input) => {
				if (input.definition === undefined) throw new Error('nothing to provision')
				provisioned.push(input.definition)
				const { configs } = await generateWranglerConfigs(input.definition, input.env)
				return { wranglerConfigs: [...configs], wranglerConfig: configs[0]?.config ?? {} }
			},
			writeOutcome: async () => {},
		},
	})({
		appId: deployment.app,
		env: deployment.env,
		domain: HOST,
		cwd: '/checkout',
		configPath: 'fabrika.config.ts',
		secrets: {},
		vars: {},
		managedEnvironment: { FABRIKA_IAM_ISSUER: ISSUER },
		dryRun: true,
		signal: new AbortController().signal,
		log: () => {},
	})
	const [root] = provisioned
	if (result.status !== 'succeeded' || root === undefined) throw new Error('the contract application did not deploy')
	return root
}

const proxyWorker = await deployedProxy()

function bakedManifest(): string {
	const encoded = proxyWorker.options.vars?.['FABRIKA_PROXY_MANIFEST_JSON']
	if (typeof encoded !== 'string') {
		throw new Error('the proxy Worker carries no manifest')
	}
	return encoded
}

const inW1 = (action: string): PermissionEntry => grant(action, { type: 'workspace', value: 'w1' })

async function minted(kind: TokenKind, perms: PermissionEntry[]): Promise<{ ok: true; token: string; expiresAt: number }> {
	return { ok: true, token: await token(kind, perms), expiresAt: Math.floor(Date.now() / 1000) + 300 }
}

interface Caller {
	readonly session?: MintTokenResult
	readonly key?: MintFromKeyResult
}

async function proxyFor(caller: Caller) {
	const implementation = notesApp(new Map())
	const app = boot(implementation, { environment: environment(frameworkEnvFor(implementation)), iam: keySource, assets: echoAssets })
	const iam = new FakeIam({
		jwks: await keySource.getJwks(),
		...(caller.session === undefined ? {} : { mintToken: caller.session }),
		...(caller.key === undefined ? {} : { mintFromKey: caller.key }),
	})
	let reached = 0
	const handler = createCloudflareProxyHandler({
		IAM: iam,
		FABRIKA_IAM_ISSUER: ISSUER,
		FABRIKA_PROXY_MANIFEST_JSON: bakedManifest(),
		APP: {
			fetch: (request: Request) => {
				reached++
				return app.fetch(request)
			},
		},
	}, silentLogger)
	return { handler, reached: () => reached }
}

function post(path: string, body: unknown, headers: Record<string, string>): Request {
	return new Request(`https://${HOST}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
	})
}

const SESSION = { Cookie: '__Host-px_session=session', 'Sec-Fetch-Site': 'same-origin' }

describe('a contract application behind its endpoint table on Cloudflare', () => {
	test('the proxy Worker bakes the endpoint table into its manifest verbatim', () => {
		expect(parseProxyManifestJson(bakedManifest())?.apps).toEqual([{ id: APP_ID, hosts: [HOST], upstream: 'APP', scheme: 'https', ...table }])
	})

	test('a proxy Worker given both a table and gates is refused', () => {
		const both = { name: 'notes-proxy', app: appWorker(), appId: APP_ID, appHost: HOST, endpoints: table, gates: { rules: [] }, iamUrl: ISSUER }
		expect(() => Reflect.apply(createCloudflareProxyWorker, undefined, [both])).toThrow(
			'exactly one of an endpoint table, an installation table or gates',
		)
		const installationAndGates = { ...both, endpoints: undefined, installation: { installation: true, endpoints: [], reservedPrefixes: [] } }
		expect(() => Reflect.apply(createCloudflareProxyWorker, undefined, [installationAndGates])).toThrow('exactly one of')
	})

	test('an anonymous health check reaches the application without a token', async () => {
		const { handler } = await proxyFor({})
		const response = await handler(new Request(`https://${HOST}/healthz`))
		expect(response.status).toBe(200)
	})

	test('a signed-in person reaches a person procedure', async () => {
		const { handler } = await proxyFor({ session: await minted('user', [inW1('notes.read')]) })
		const response = await handler(post('/api/notes.list', {}, SESSION))
		expect(response.status).toBe(200)
		expect(await response.json<unknown>()).toEqual({ result: { items: [] } })
	})

	test('a machine key reaches the machine procedure', async () => {
		const { handler } = await proxyFor({ key: await minted('service', [inW1('notes.write')]) })
		const response = await handler(post('/machine/importNotes', { workspaceId: 'w1', titles: ['a'] }, { Authorization: 'Bearer px_key' }))
		expect(response.status).toBe(200)
		expect(await response.json<unknown>()).toEqual({ result: { imported: 1 } })
	})

	test('without a session a person procedure answers the login challenge and never reaches the application', async () => {
		const { handler, reached } = await proxyFor({})
		const response = await handler(post('/api/notes.list', {}, { 'Sec-Fetch-Mode': 'cors' }))
		expect(response.status).toBe(401)
		expect(reached()).toBe(0)
	})

	test('a session on the machine path is 401 at the proxy: no fall-through to the SPA', async () => {
		const { handler, reached } = await proxyFor({ session: await minted('user', [inW1('notes.write')]) })
		const response = await handler(post('/machine/importNotes', { workspaceId: 'w1', titles: ['a'] }, SESSION))
		expect(reached()).toBe(0)
		expect(response.status).toBe(401)
	})

	test('a person key on the machine path, and a reader on a write procedure, are 403 at the proxy', async () => {
		const keyed = await proxyFor({ key: await minted('user', [inW1('notes.write')]) })
		expect((await keyed.handler(post('/machine/importNotes', { workspaceId: 'w1', titles: ['a'] }, { Authorization: 'Bearer px_key' }))).status).toBe(
			403,
		)
		const reader = await proxyFor({ session: await minted('user', [inW1('notes.read')]) })
		expect((await reader.handler(post('/api/notes.create', { workspaceId: 'w1', title: 'x' }, SESSION))).status).toBe(403)
		expect(keyed.reached() + reader.reached()).toBe(0)
	})
})
