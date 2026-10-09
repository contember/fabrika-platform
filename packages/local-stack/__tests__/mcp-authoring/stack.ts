// The MCP authoring path composed in one process: the real IAM application, the real proxy decision,
// and the real Control Bun handler with its real workspace source, which reads the GitHub App key from
// Control's vault. Requests travel between them over an in-memory network keyed by origin. The stand-ins
// are the client's CIMD document, the GitHub repository (`FakeGitHubRepository`) behind the App client,
// and the Caddy hop in front of Control (`edge`, which does what `forward_auth` + `copy_headers` do). Control reads
// its MCP switch from the digest of the table this proxy publishes, as a composition writes it.

import { HttpIamRpc } from '@fabrika/auth'
import { ENDPOINT_HEADER, PROXY_TOKEN_HEADER } from '@fabrika/auth-core'
import {
	CONTROL_MCP_SCOPE,
	controlMcpResource,
	controlMcpResourceMetadata,
	controlMcpSwitch,
	controlServiceContract,
	controlServiceDigest,
} from '@fabrika/control/service'
import {
	APP_QUERY_PARAM,
	createVerifyService,
	DEFAULT_VERIFY_PATH,
	FORWARDED_HOST_HEADER,
	FORWARDED_METHOD_HEADER,
	FORWARDED_PROTO_HEADER,
	FORWARDED_URI_HEADER,
	HttpIamGateway,
	OAUTH_METADATA_VERIFY_PATH,
} from '@fabrika/proxy-core'
import { parseProxyManifest, serviceProxyTable } from '@fabrika/proxy-core/manifest'
import { spyOn } from 'bun:test'
import { createHarness as createControlHarness } from '../../../control/src/__tests__/helpers/harness'
import { allowAllAuth } from '../../../control/src/__tests__/helpers/iam'
import { unusedSourceConnection } from '../../../control/src/__tests__/helpers/source-connection'
import { CONNECTION_ID, seedWorkspaceWorld, type WorkspaceWorld, zeropsProvider } from '../../../control/src/__tests__/helpers/workspaces'
import type { Env as ControlEnv } from '../../../control/src/env'
import { encodeGitHubAppCredential } from '../../../control/src/github/connections/credentials'
import { githubAppCredentialSecretLabel } from '../../../control/src/github/connections/secrets'
import { githubWorkspaceSource } from '../../../control/src/github/workspace'
import { Vault } from '../../../control/src/vault'
import { controlMcpRoute } from '../../../control/src/zerops/mcp'
import { createFetchHandler } from '../../../control/src/zerops/server'
import { createHarness as createIamHarness, type Harness as IamHarness, seedInlineGrant, seedUser } from '../../../iam/src/__tests__/helpers/harness'
import { createIamApp } from '../../../iam/src/app'
import type { Env as IamEnv } from '../../../iam/src/env'
import { FakeGitHubRepository } from './github-repository'

/** The console's public origin; the MCP resource is `${CONSOLE}/mcp`. */
export const CONSOLE = 'https://console.example.test'
/** IAM's public issuer — where a client's browser signs in and consents. */
export const ISSUER = 'https://iam.example.test'
/** IAM's private address, the one Control and the proxy call. */
const IAM_PRIVATE = 'http://iam.internal:3000'
const CLIENT_ORIGIN = 'https://claude.example.test'
export const REDIRECT_URI = `${CLIENT_ORIGIN}/api/mcp/auth_callback`
export const RESOURCE = controlMcpResource(CONSOLE)

const IAM_RPC_KEY = 'iam-rpc-key-for-the-in-process-mcp-witness'
const IAM_PROXY_KEY = 'iam-proxy-key-for-the-in-process-mcp-witness'
const CONSOLE_APP_ID = 'vozka'
export const AUTHORING_GRANTS = ['source.workspace.read', 'source.workspace.write', 'source.pull-request.create', 'deploy.trigger', 'deploy.read']
const CONTROL_VAULT_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index + 1)))

type Handler = (request: Request) => Promise<Response>

export interface Person {
	readonly principalId: string
	/** Plaintext IAM session cookie value — what the person's browser holds after signing in. */
	readonly session: string
}

export interface McpStack {
	/** What a client on the internet reaches; nothing private is routed from here. */
	readonly internet: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
	/** The proxy's `/verify` decision for one request to the console, as Caddy's `forward_auth` asks it. */
	readonly decide: (request: Request) => Promise<Response>
	/** Control's own handler, behind the proxy. */
	readonly control: Handler
	readonly proxyIam: HttpIamGateway
	readonly world: WorkspaceWorld
	readonly repository: FakeGitHubRepository
	readonly clientId: string
	readonly addPerson: (email: string, grants: readonly string[]) => Promise<Person>
	readonly stop: () => Promise<void>
}

export async function createMcpStack(): Promise<McpStack> {
	const backgroundWork: Promise<unknown>[] = []
	const routes = new Map<string, Handler>()
	const network = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init)
		const handler = routes.get(new URL(request.url).origin)
		if (handler === undefined) return Promise.reject(new Error(`no route to ${new URL(request.url).origin} in the in-process stack`))
		return handler(request)
	}
	// IAM fetches the CIMD document with the global fetch; no request of this stack may leave the process.
	const nativeFetch = globalThis.fetch
	const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(network, { preconnect: nativeFetch.preconnect }))

	const clientId = `${CLIENT_ORIGIN}/oauth/${crypto.randomUUID()}/client.json`
	routes.set(CLIENT_ORIGIN, (request) => {
		if (request.url !== clientId) return Promise.resolve(new Response('not found', { status: 404 }))
		return Promise.resolve(Response.json({
			client_id: clientId,
			client_name: 'Claude',
			redirect_uris: [REDIRECT_URI],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
		}))
	})

	const iamHarness = createIamHarness()
	const iamEnv = await iamEnvironment(iamHarness, clientId)
	const iam = createIamApp({ rpcKey: IAM_RPC_KEY, proxyKey: IAM_PROXY_KEY })
	const iamHandler: Handler = (request) =>
		iam.fetch(request, iamEnv, {
			waitUntil: (promise) => {
				backgroundWork.push(promise)
			},
		})
	routes.set(ISSUER, iamHandler)
	routes.set(IAM_PRIVATE, iamHandler)

	const repository = new FakeGitHubRepository('acme', 'shop', 'main', {
		'README.md': '# shop\n',
		'src/index.ts': "export const greeting = 'hello'\n",
		'zerops.yaml': 'zerops: []\n',
	})
	const controlHarness = createControlHarness()
	const world = await seedWorkspaceWorld(controlHarness.repositories, controlHarness.d1)
	await sealGitHubAppKey(controlHarness)
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
		WAIT_UNTIL: (promise) => {
			backgroundWork.push(promise)
		},
		IAM: new HttpIamRpc({ origin: IAM_PRIVATE, key: IAM_RPC_KEY, fetch: network }),
		FABRIKA_IAM_ISSUER: ISSUER,
		ENVIRONMENT: 'stage',
		FABRIKA_CONTROL_DOMAIN: CONSOLE,
		FABRIKA_CONTROL_VAULT_KEY: CONTROL_VAULT_KEY,
	}
	const workspaceSource = githubWorkspaceSource(controlEnv, () => Promise.resolve({ openRepository: (input) => repository.open(input) }))
	const mcp = controlMcpSwitch(controlServiceDigest({ mcp: true }))
	const control = createFetchHandler(
		controlEnv,
		zeropsProvider,
		unusedSourceConnection('zerops'),
		mcp ? controlMcpRoute(controlEnv, workspaceSource) : null,
	)

	const manifest = parseProxyManifest({
		apps: [{
			id: CONSOLE_APP_ID,
			hosts: [new URL(CONSOLE).hostname],
			upstream: 'control:3000',
			scheme: 'https',
			...serviceProxyTable(controlServiceContract({ mcp }), { oauth: mcp }),
			oauthResources: [{
				resource: RESOURCE,
				resourceMetadata: controlMcpResourceMetadata(CONSOLE),
				authorizationServers: [ISSUER],
				scopesSupported: [CONTROL_MCP_SCOPE],
			}],
		}],
	})
	if (manifest === null) throw new Error('the console proxy manifest does not parse')
	const proxyIam = new HttpIamGateway({ origin: IAM_PRIVATE, key: IAM_PROXY_KEY, fetch: network })
	const verify = createVerifyService({ manifest, iam: proxyIam, issuer: ISSUER })
	const metadataPath = new URL(controlMcpResourceMetadata(CONSOLE)).pathname

	const decide = (request: Request): Promise<Response> => verify(forwardAuth(request, DEFAULT_VERIFY_PATH))
	routes.set(CONSOLE, async (request) => {
		if (new URL(request.url).pathname === metadataPath) return verify(forwardAuth(request, OAUTH_METADATA_VERIFY_PATH))
		const decision = await decide(request)
		if (!decision.ok) return decision
		const headers = new Headers(request.headers)
		for (const name of [PROXY_TOKEN_HEADER, ENDPOINT_HEADER]) {
			headers.delete(name)
			const value = decision.headers.get(name)
			if (value !== null) headers.set(name, value)
		}
		return control(new Request(request, { headers }))
	})

	const publicOrigins = new Set([CONSOLE, ISSUER])
	return {
		internet: (input, init) => {
			const request = new Request(input, init)
			if (!publicOrigins.has(new URL(request.url).origin)) return Promise.reject(new Error(`${request.url} is not publicly routed`))
			return network(request)
		},
		decide,
		control,
		proxyIam,
		world,
		repository,
		clientId,
		addPerson: async (email, grants) => {
			const principalId = seedUser(iamHarness.sqlite, { sub: `sub-${email}`, email })
			if (grants.length > 0) seedInlineGrant(iamHarness.sqlite, principalId, [...grants], { type: 'app', value: 'shop' }, CONSOLE_APP_ID)
			const session = await iamHarness.signSession(principalId, { idpSub: null, email, authenticationMethod: 'password' })
			return { principalId, session }
		},
		stop: async () => {
			await Promise.allSettled(backgroundWork)
			fetchSpy.mockRestore()
			iamHarness.sqlite.close()
			controlHarness.sqlite.close()
		},
	}
}

/** IAM as a stage installation: a durable signing key, password sign-in, and MCP OAuth for the console resource. */
async function iamEnvironment(harness: IamHarness, clientId: string): Promise<IamEnv> {
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
		ENVIRONMENT: 'stage',
		ISSUER,
		FABRIKA_IAM_SIGNING_KEYS: JSON.stringify([await crypto.subtle.exportKey('jwk', pair.privateKey)]),
		FABRIKA_IAM_PROVISIONING_KEY: '',
		OIDC_ENABLED: 'false',
		PASSWORD_ENABLED: 'true',
		OAUTH_CONFIG: JSON.stringify({
			clients: [{ provider: 'claude', clientId, redirectUris: [REDIRECT_URI] }],
			resources: [{
				app: CONSOLE_APP_ID,
				resource: RESOURCE,
				defaultScopes: [CONTROL_MCP_SCOPE],
				scopeGrants: [{ scope: CONTROL_MCP_SCOPE, permissions: AUTHORING_GRANTS.map((action) => ({ action })) }],
			}],
		}),
	}
}

/** Seal the world connection's GitHub App key in Control's vault, under the purpose the connection names. */
async function sealGitHubAppKey(harness: ReturnType<typeof createControlHarness>): Promise<void> {
	const vault = await Vault.create(harness.d1, CONTROL_VAULT_KEY)
	const credentialRef = await vault.putSecret(
		'platform',
		githubAppCredentialSecretLabel(CONNECTION_ID),
		encodeGitHubAppCredential({ appId: '123', privateKeyPem: 'in-process-app-key' }),
	)
	harness.sqlite.query('UPDATE github_source_connections_keyed SET app_credential_ref = ? WHERE connection_id = ?').run(credentialRef, CONNECTION_ID)
}

/** The `/verify` subrequest Caddy's `forward_auth` sends for one request to the console. */
function forwardAuth(request: Request, endpoint: string): Request {
	const url = new URL(request.url)
	const headers = new Headers(request.headers)
	headers.set(FORWARDED_METHOD_HEADER, request.method)
	headers.set(FORWARDED_URI_HEADER, `${url.pathname}${url.search}`)
	headers.set(FORWARDED_HOST_HEADER, url.host)
	headers.set(FORWARDED_PROTO_HEADER, url.protocol.slice(0, -1))
	return new Request(`http://proxy.internal:9000${endpoint}?${APP_QUERY_PARAM}=${CONSOLE_APP_ID}`, { method: 'GET', headers })
}
