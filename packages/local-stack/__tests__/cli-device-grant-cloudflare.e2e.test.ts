/**
 * The command-line client's device grant on a Cloudflare installation, end to end in one process (ADR-0049). Every
 * piece is built from what that installation's stages deploy: IAM with the `OAUTH_CONFIG` its `fabrika.config.ts`
 * computes, the console's proxy Worker handler with the manifest `buildControlWorker` bakes into it, and the console
 * Worker's app chosen by the table digest the same config writes beside that manifest. The `fabrika` CLI's own device
 * grant and transport run unchanged. Requests travel over an in-memory network keyed by origin; the proxy reaches IAM
 * over HTTP where the deployed Worker uses its service binding, which serves the same gateway.
 *
 * It lives OUTSIDE `src/` for the reason `mcp-authoring.e2e.test.ts` does: Control's Worker graph needs the Cloudflare
 * ambient types this package's `src/` does not load.
 */

import { createRpcClient } from '@fabrika/app'
import { HttpIamRpc } from '@fabrika/auth'
import { SESSION_COOKIE } from '@fabrika/auth-core'
import type { ControlRpcContract } from '@fabrika/control-contract'
import { buildIamWorker } from '@fabrika/iam/fabrika.config'
import { platformIamOAuthConfig } from '@fabrika/installation-init'
import { proxyManifestJson, Worker } from '@fabrika/provider-cloudflare'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE } from '@fabrika/provider-zerops/installation'
import { HttpIamGateway } from '@fabrika/proxy-core'
import { parseProxyManifestJson } from '@fabrika/proxy-core/manifest'
import { afterEach, expect, test } from 'bun:test'
import { controlTransport } from '../../cli/src/control'
import { authorizeDevice, type ControlOAuthDependencies, type CredentialLock } from '../../cli/src/control-oauth'
import buildControlConfig from '../../control/fabrika.config'
import { createHarness as createControlHarness } from '../../control/src/__tests__/helpers/harness'
import { allowAllAuth } from '../../control/src/__tests__/helpers/iam'
import { fakeControlProvider } from '../../control/src/__tests__/helpers/provider'
import { unusedSourceConnection } from '../../control/src/__tests__/helpers/source-connection'
import { seedWorkspaceWorld } from '../../control/src/__tests__/helpers/workspaces'
import { workerControlApp } from '../../control/src/app'
import type { Env as ControlEnv } from '../../control/src/env'
import { createHarness as createIamHarness, seedInlineGrant, seedUser } from '../../iam/src/__tests__/helpers/harness'
import { createIamApp } from '../../iam/src/app'
import type { Env as IamEnv } from '../../iam/src/env'
import { parseOAuthConfig } from '../../iam/src/oauth-config'
import { buildOperationsWorker } from '../../operations/fabrika.config'
import { createCloudflareProxyHandler } from '../../provider-cloudflare/src/proxy-worker'

const CONSOLE_HOST = 'console.example.test'
const CONSOLE = `https://${CONSOLE_HOST}`
const IAM_HOST = 'iam.example.test'
const ISSUER = `https://${IAM_HOST}`
/** IAM's private address, the one the proxy and Control call. */
const IAM_PRIVATE = 'http://iam.internal:3000'
const IAM_RPC_KEY = 'iam-rpc-key-for-the-in-process-device-grant'
const IAM_PROXY_KEY = 'iam-proxy-key-for-the-in-process-device-grant'
const DEPLOY_ACTIONS = ['data.read', 'deploy.read', 'deploy.trigger']

type Handler = (request: Request) => Promise<Response>

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Run `body` with `values` in process.env, then put back what was there before, set or not. */
function withEnvironment<T>(values: Readonly<Record<string, string>>, body: () => T): T {
	const before = Object.keys(values).map((name): [string, string | undefined] => [name, process.env[name]])
	Object.assign(process.env, values)
	try {
		return body()
	} finally {
		for (const [name, value] of before) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
	}
}

function stringVar(worker: Worker, name: string): string {
	const value = worker.options.vars?.[name]
	if (typeof value !== 'string') throw new Error(`the ${worker.options.name} Worker has no ${name} var`)
	return value
}

async function createCloudflareInstallation() {
	const backgroundWork: Promise<unknown>[] = []
	const exec = { waitUntil: (promise: Promise<unknown>) => void backgroundWork.push(promise) }
	const routes = new Map<string, Handler>()
	const network = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init)
		const handler = routes.get(new URL(request.url).origin)
		if (handler === undefined) return Promise.reject(new Error(`no route to ${new URL(request.url).origin} in the in-process installation`))
		return handler(request)
	}

	// Stage 1: IAM, as its workflow step deploys it, with the console's origin it is handed.
	const iamWorker = buildIamWorker({ env: 'prod', domain: IAM_HOST }, {
		FABRIKA_IAM_OIDC_ENABLED: 'false',
		FABRIKA_IAM_PASSWORD_ENABLED: 'true',
		FABRIKA_IAM_SIGNING_KEYS: 'unused-by-this-harness',
		FABRIKA_IAM_PROVISIONING_KEY: 'px_provisioning',
		FABRIKA_EMAIL_PROVIDER: 'none',
		FABRIKA_CONTROL_URL: CONSOLE,
	})
	const iamHarness = createIamHarness()
	cleanups.push(() => iamHarness.sqlite.close())
	const iamEnv = await iamEnvironment(iamHarness, stringVar(iamWorker, 'ISSUER'), stringVar(iamWorker, 'OAUTH_CONFIG'))
	const iam = createIamApp({ rpcKey: IAM_RPC_KEY, proxyKey: IAM_PROXY_KEY })
	const iamHandler: Handler = (request) => iam.fetch(request, iamEnv, exec)
	routes.set(ISSUER, iamHandler)
	routes.set(IAM_PRIVATE, iamHandler)

	// Stage 3: the console's proxy Worker and the console Worker behind it, from one config.
	const proxyWorker = withEnvironment({ FABRIKA_IAM_ISSUER: ISSUER }, () => buildControlConfig.resources({ env: 'prod', domain: CONSOLE_HOST }))
	const appBinding = proxyWorker.options.bindings?.['APP']
	if (!(appBinding instanceof Worker)) throw new Error('the console proxy binds no console Worker')
	const controlHarness = createControlHarness()
	cleanups.push(() => controlHarness.sqlite.close())
	const world = await seedWorkspaceWorld(controlHarness.repositories, controlHarness.d1)
	const ports = world.context(allowAllAuth())
	const controlEnv: ControlEnv = {
		DB: controlHarness.d1,
		REPOSITORIES: controlHarness.repositories,
		ASSETS: { fetch: () => Promise.resolve(new Response('spa')) },
		RUN_LOGS: {
			get: (key) => ports.logs.get(key),
			put: () => Promise.reject(new Error('unused')),
			delete: () => Promise.reject(new Error('unused')),
		},
		DEPLOY_QUEUE: ports.queue,
		WAIT_UNTIL: exec.waitUntil,
		IAM: new HttpIamRpc({ origin: IAM_PRIVATE, key: IAM_RPC_KEY, fetch: network }),
		FABRIKA_IAM_ISSUER: stringVar(appBinding, 'FABRIKA_IAM_ISSUER'),
		ENVIRONMENT: 'prod',
		FABRIKA_CONTROL_DOMAIN: stringVar(appBinding, 'FABRIKA_CONTROL_DOMAIN'),
	}
	const console_ = workerControlApp({
		FABRIKA_CONTROL_DOMAIN: stringVar(appBinding, 'FABRIKA_CONTROL_DOMAIN'),
		FABRIKA_SERVICE_TABLE_DIGEST: stringVar(appBinding, 'FABRIKA_SERVICE_TABLE_DIGEST'),
	})
	const proxy = createCloudflareProxyHandler({
		IAM: new HttpIamGateway({ origin: IAM_PRIVATE, key: IAM_PROXY_KEY, fetch: network }),
		FABRIKA_IAM_ISSUER: stringVar(proxyWorker, 'FABRIKA_IAM_ISSUER'),
		FABRIKA_PROXY_MANIFEST_JSON: proxyManifestJson(proxyWorker) ?? '',
		APP: {
			fetch: (request: Request) =>
				console_.fetch(request, { env: controlEnv, provider: fakeControlProvider, sourceConnection: unusedSourceConnection('cloudflare') }, exec),
		},
	})
	routes.set(CONSOLE, proxy)
	cleanups.push(async () => {
		await Promise.allSettled(backgroundWork)
	})

	const publicOrigins = new Set([CONSOLE, ISSUER])
	const internet = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init)
		if (!publicOrigins.has(new URL(request.url).origin)) return Promise.reject(new Error(`${request.url} is not publicly routed`))
		return network(request)
	}
	const addPerson = async (email: string, actions: readonly string[]) => {
		const principalId = seedUser(iamHarness.sqlite, { sub: `sub-${email}`, email })
		seedInlineGrant(iamHarness.sqlite, principalId, [...actions], { type: 'app', value: 'shop' }, 'vozka')
		const session = await iamHarness.signSession(principalId, { idpSub: null, email, authenticationMethod: 'password' })
		return { principalId, session }
	}
	/** Let the device's next poll through at once, as if its interval had passed. */
	const pollInterval = () => iamHarness.sqlite.run('UPDATE oauth_device_authorizations SET next_poll_at = 0')
	return { internet, addPerson, pollInterval }
}

/** IAM as its Worker runs: the issuer and the OAuth config from its vars, a signing key and password sign-in. */
async function iamEnvironment(harness: ReturnType<typeof createIamHarness>, issuer: string, oauthConfig: string): Promise<IamEnv> {
	const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
	const unusedDatabase = {
		prepare(): never {
			throw new Error('IAM reaches its database through REPOSITORIES')
		},
		batch(): Promise<never> {
			return Promise.reject(new Error('IAM reaches its database through REPOSITORIES'))
		},
	}
	return {
		DB: unusedDatabase,
		REPOSITORIES: harness.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'prod',
		ISSUER: issuer,
		FABRIKA_IAM_SIGNING_KEYS: JSON.stringify([await crypto.subtle.exportKey('jwk', pair.privateKey)]),
		FABRIKA_IAM_PROVISIONING_KEY: '',
		OIDC_ENABLED: 'false',
		PASSWORD_ENABLED: 'true',
		OAUTH_CONFIG: oauthConfig,
	}
}

test('an agent obtains a device grant on a Cloudflare installation and calls Control with it', async () => {
	const installation = await createCloudflareInstallation()
	const person = await installation.addPerson('dev@example.test', DEPLOY_ACTIONS)

	// The console's proxy names IAM as the authorization server of its RPC, which the CLI discovers from.
	const metadata = await installation.internet(`${CONSOLE}/.well-known/oauth-protected-resource/api/rpc`)
	expect(metadata.status).toBe(200)
	expect(await metadata.json()).toMatchObject({ resource: `${CONSOLE}/api/rpc`, authorization_servers: [ISSUER] })

	let stored: string | null = null
	let userCode: string | null = null
	let approval: Response | null = null
	const noLock: CredentialLock = () => Promise.resolve(() => Promise.resolve())
	const deps: ControlOAuthDependencies = {
		fetch: installation.internet,
		helper: {
			get: () => Promise.resolve(stored),
			store: (_origin, token) => {
				stored = token
				return Promise.resolve()
			},
		},
		lock: noLock,
		now: Date.now,
		// The person approves in the browser while the CLI waits for its first poll.
		sleep: async () => {
			if (approval === null && userCode !== null) {
				approval = await installation.internet(`${ISSUER}/oauth/device`, {
					method: 'POST',
					headers: {
						cookie: `${SESSION_COOKIE}=${person.session}`,
						origin: 'null',
						'sec-fetch-site': 'same-origin',
						'content-type': 'application/x-www-form-urlencoded',
					},
					body: new URLSearchParams({ user_code: userCode, decision: 'approve', lifetime: '3600' }),
				})
			}
			installation.pollInterval()
		},
		note: (message) => {
			userCode ??= /confirm the code ([A-Z]{4}-[A-Z]{4})/.exec(message)?.[1] ?? null
		},
	}

	await authorizeDevice({ origin: CONSOLE, preset: 'deploy', app: 'shop' }, deps)
	expect(approval?.status).toBe(200)
	expect(stored).not.toBeNull()

	const transport = controlTransport(CONSOLE, { FABRIKA_CONTROL_CREDENTIAL_HELPER: 'in-process' }, installation.internet, deps)
	const client = createRpcClient<ControlRpcContract>({ baseUrl: `${transport.origin}/api/rpc`, fetch: transport.fetch })
	const access = await client.consoleAccess()
	expect(access.principal?.id).toBe(person.principalId)
	expect(access.global).toEqual([])
	expect(access.scopes.map(({ type, value, actions }) => ({ type, value, actions: [...actions].sort() }))).toEqual([
		{ type: 'app', value: 'shop', actions: DEPLOY_ACTIONS },
	])
})

test('a Cloudflare IAM deploy serves the command-line client the very resources a Zerops deploy does', () => {
	const zerops = platformIamOAuthConfig(PLATFORM_PROXY_MANIFEST_TEMPLATE, {
		scheme: 'https',
		placement: { iam: { hosts: [IAM_HOST] }, control: { hosts: [CONSOLE_HOST] }, operations: { hosts: ['operations.example.test'] } },
		mcp: false,
		authorizationServer: ISSUER,
	})
	const cloudflare = buildIamWorker({ env: 'prod', domain: IAM_HOST }, {
		FABRIKA_IAM_OIDC_ENABLED: 'false',
		FABRIKA_IAM_PASSWORD_ENABLED: 'true',
		FABRIKA_IAM_SIGNING_KEYS: 'unused-by-this-test',
		FABRIKA_IAM_PROVISIONING_KEY: 'px_provisioning',
		FABRIKA_EMAIL_PROVIDER: 'none',
		FABRIKA_CONTROL_URL: CONSOLE,
		OPERATIONS_HOSTNAME: 'operations.example.test',
	})
	expect(JSON.parse(stringVar(cloudflare, 'OAUTH_CONFIG'))).toEqual(zerops)
})

test('Operations accepts the very resource IAM serves and the console proxy registers for its path', () => {
	const iam = buildIamWorker({ env: 'prod', domain: IAM_HOST }, {
		FABRIKA_IAM_OIDC_ENABLED: 'false',
		FABRIKA_IAM_PASSWORD_ENABLED: 'true',
		FABRIKA_IAM_SIGNING_KEYS: 'unused-by-this-test',
		FABRIKA_IAM_PROVISIONING_KEY: 'px_provisioning',
		FABRIKA_EMAIL_PROVIDER: 'none',
		FABRIKA_CONTROL_URL: CONSOLE,
	})
	const iamResources = parseOAuthConfig(stringVar(iam, 'OAUTH_CONFIG'))?.resources.map((resource) => resource.resource)
	const proxy = withEnvironment({ FABRIKA_IAM_ISSUER: ISSUER }, () => buildControlConfig.resources({ env: 'prod', domain: CONSOLE_HOST }))
	const entry = parseProxyManifestJson(proxyManifestJson(proxy) ?? '')?.apps[0]
	if (entry === undefined || !('installation' in entry)) throw new Error('expected the console installation entry')
	const operations = buildOperationsWorker({ env: 'prod', domain: 'operations.example.test' }, { FABRIKA_CONTROL_URL: CONSOLE })

	const accepted = stringVar(operations, 'FABRIKA_OPERATIONS_OAUTH_RESOURCE')
	expect(accepted).toBe(`${CONSOLE}/operations/api/rpc`)
	expect(entry.oauthResources?.map((resource) => resource.resource)).toContain(accepted)
	expect(iamResources).toContain(accepted)
})
