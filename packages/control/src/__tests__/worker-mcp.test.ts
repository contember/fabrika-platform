// `/mcp` on the Cloudflare Worker (ADR-0049 rule 9): the console the Worker composes per table digest mounts the same
// handler as the Bun process, over the skill the deploy embeds, with the Cloudflare provider's authoring declaration.

import { readAppAgentSkill } from '@fabrika/app/agent-skill'
import { PROXY_TOKEN_HEADER } from '@fabrika/auth'
import { CLOUDFLARE_STAGE_DEPLOY_REFUSAL, createCloudflareControlProvider } from '@fabrika/provider-cloudflare/runner'
import type { ControlProvider } from '@fabrika/provider-contract'
import { afterEach, describe, expect, test } from 'bun:test'
import { controlMcpResource, controlMcpResourceMetadata, controlServiceDigest, ControlTableError } from '../../fabrika.service'
import { workerControlApp } from '../app'
import type { Env } from '../env'
import { exactPinSatisfies, parseAppAgentSkill } from '../mcp/app-rules'
import { workerMcpRoute } from '../mcp/worker'
import { createHarness, type Harness } from './helpers/harness'
import { allowAllAuth } from './helpers/iam'
import { proxiedRequest } from './helpers/proxy'
import { unusedSourceConnection } from './helpers/source-connection'
import { testIamEnv, testResourceToken } from './helpers/tokens'
import { AUTHOR_ACTIONS, seedWorkspaceWorld, sha, type WorkspaceWorld } from './helpers/workspaces'

const DOMAIN = 'console.example.com'
const ORIGIN = `https://${DOMAIN}`
const RESOURCE = controlMcpResource(ORIGIN)
const MCP_TABLE = controlServiceDigest({ mcp: true, cli: true })

/** The skill as `fabrika.config.ts` embeds it in a Worker that serves MCP. */
const embeddedSkill = (): string => {
	const { version, body, references } = readAppAgentSkill()
	return JSON.stringify({ version, body, references: references.map(({ topic, text }) => ({ topic, text })) })
}

const unused = (): Promise<never> => Promise.reject(new Error('the runner is not exercised by this test'))

/** The Cloudflare control provider over runner ports this test never reaches. */
const cloudflareProvider = (isolatedBuild?: boolean): ControlProvider =>
	createCloudflareControlProvider({
		accountId: 'account',
		apiToken: 'token',
		runnerKey: 'runner',
		resolveSource: unused,
		prepareClone: unused,
		startRun: unused,
		cancelRun: () => Promise.resolve(),
		...(isolatedBuild === undefined ? {} : { isolatedBuild }),
	})

let harness: Harness | null = null
afterEach(() => {
	harness?.sqlite.close()
	harness = null
})

async function fixture(
	options: { readonly provider?: ControlProvider; readonly digest?: string } = {},
): Promise<{ world: WorkspaceWorld; fetch: (request: Request) => Promise<Response> }> {
	harness = createHarness()
	const world = await seedWorkspaceWorld(harness.repositories, harness.d1)
	const context = world.context(allowAllAuth())
	const env: Env = {
		...testIamEnv,
		DB: harness.d1,
		REPOSITORIES: harness.repositories,
		ASSETS: { fetch: () => Promise.resolve(new Response('spa')) },
		RUN_LOGS: {
			get: (key) => context.logs.get(key),
			put: () => Promise.reject(new Error('unused')),
			delete: () => Promise.reject(new Error('unused')),
		},
		DEPLOY_QUEUE: context.queue,
		WAIT_UNTIL: () => {},
		ENVIRONMENT: 'prod',
		FABRIKA_CONTROL_DOMAIN: DOMAIN,
	}
	const digest = options.digest ?? MCP_TABLE
	const app = workerControlApp(
		{ FABRIKA_CONTROL_DOMAIN: DOMAIN, FABRIKA_SERVICE_TABLE_DIGEST: digest },
		workerMcpRoute(embeddedSkill(), () => world.source),
	)
	const provider = options.provider ?? cloudflareProvider(false)
	return {
		world,
		fetch: (request) =>
			app.fetch(proxiedRequest(request, { mcp: digest === MCP_TABLE }), { env, provider, sourceConnection: unusedSourceConnection('cloudflare') }, {
				waitUntil() {},
			}),
	}
}

function mcpRequest(body: unknown, token?: string): Request {
	const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' })
	if (token !== undefined) headers.set(PROXY_TOKEN_HEADER, token)
	return new Request(`${ORIGIN}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
}

async function rpc(fetch: (request: Request) => Promise<Response>, token: string, method: string, params: object): Promise<unknown> {
	const response = await fetch(mcpRequest({ jsonrpc: '2.0', id: 1, method, params }, token))
	expect(response.status).toBe(200)
	const text = await response.text()
	if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) return JSON.parse(text)
	const last = text.split('\n').filter((line) => line.startsWith('data:')).at(-1)
	if (last === undefined) throw new Error('expected an SSE data frame')
	return JSON.parse(last.slice('data:'.length))
}

const authorToken = (): Promise<string> => testResourceToken({ resource: RESOURCE, label: 'author@acme.test', actions: AUTHOR_ACTIONS })

async function createWorkspace(fetch: (request: Request) => Promise<Response>, token: string): Promise<unknown> {
	const created = await rpc(fetch, token, 'tools/call', { name: 'create_workspace', arguments: { appId: 'shop', env: 'stage', title: 'Banner' } })
	return field(toolJson(created), 'id')
}

describe('the Worker console with the MCP table', () => {
	test('initialize and tools/list answer an authoring token', async () => {
		const { fetch } = await fixture()
		const token = await authorToken()
		const initialized = await rpc(fetch, token, 'initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'test', version: '1.0.0' },
		})
		expect(String(field(field(initialized, 'result'), 'instructions'))).toStartWith('Edit applications on Fabrika.')
		const tools = field(field(await rpc(fetch, token, 'tools/list', {}), 'result'), 'tools')
		const names = Array.isArray(tools) ? tools.map((tool) => String(field(tool, 'name'))) : []
		expect(names).toEqual(expect.arrayContaining(['apply_changes', 'create_pull_request', 'deploy_stage', 'get_app_rules', 'get_deployment']))
	})

	test('a request without a token, or with a token for another resource, gets the resource challenge', async () => {
		const { fetch } = await fixture()
		const missing = await fetch(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
		expect(missing.status).toBe(401)
		expect(missing.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${controlMcpResourceMetadata(ORIGIN)}"`)
		const foreign = await testResourceToken({ resource: 'https://other.example.com/mcp', label: 'author@acme.test', actions: AUTHOR_ACTIONS })
		const refused = await fetch(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, foreign))
		expect(refused.status).toBe(401)
	})

	test('get_app_rules answers the embedded skill', async () => {
		const { fetch } = await fixture()
		const skill = readAppAgentSkill()
		const answered = field(await rpc(fetch, await authorToken(), 'tools/call', { name: 'get_app_rules', arguments: {} }), 'result')
		expect(field(answered, 'content')).toEqual([{ type: 'text', text: `fabrika-app ${skill.version}\n\n${skill.body}` }])
	})

	test('apply_changes and create_pull_request work, and deploy_stage refuses until the runner builds in isolation', async () => {
		const { fetch, world } = await fixture()
		const token = await authorToken()
		const workspaceId = await createWorkspace(fetch, token)
		world.source.contents.set('src/app.ts', 'title = "Old"')
		const edited = await rpc(fetch, token, 'tools/call', {
			name: 'apply_changes',
			arguments: {
				workspaceId,
				expectedHeadSha: sha('a'),
				message: 'Retitle',
				changes: [{ path: 'src/app.ts', oldString: '"Old"', newString: '"New"' }],
			},
		})
		expect(toolJson(edited)).toEqual({ commitSha: sha('1') })

		const deployed = await rpc(fetch, token, 'tools/call', { name: 'deploy_stage', arguments: { workspaceId } })
		expect(deployed).toMatchObject({ result: { isError: true, content: [{ type: 'text', text: CLOUDFLARE_STAGE_DEPLOY_REFUSAL }] } })
		expect(world.queued).toEqual([])
		expect(await world.repositories.runs.listRuns({ appId: 'shop', limit: 10 })).toEqual([])

		const opened = await rpc(fetch, token, 'tools/call', { name: 'create_pull_request', arguments: { workspaceId, title: 'Retitle', body: 'b' } })
		expect(field(field(opened, 'result'), 'isError')).not.toBe(true)
		expect(world.source.kinds()).toContain('pull-request')
	})

	test("Cloudflare's deploy files are protected", async () => {
		const { fetch, world } = await fixture()
		const token = await authorToken()
		const workspaceId = await createWorkspace(fetch, token)
		const refused = await rpc(fetch, token, 'tools/call', {
			name: 'apply_changes',
			arguments: { workspaceId, expectedHeadSha: sha('a'), message: 'm', changes: [{ path: 'apps/web/wrangler.jsonc', content: '{}' }] },
		})
		expect(refused).toMatchObject({
			result: { isError: true, content: [{ type: 'text', text: 'protected paths cannot be changed through a workspace: apps/web/wrangler.jsonc' }] },
		})
		expect(world.source.kinds()).toEqual(['read-branch', 'create-branch'])
	})

	test('with the isolated build, deploy_stage creates a run for the workspace head', async () => {
		const { fetch, world } = await fixture({ provider: cloudflareProvider(true) })
		const token = await authorToken()
		const workspaceId = await createWorkspace(fetch, token)
		const deployed = toolJson(await rpc(fetch, token, 'tools/call', { name: 'deploy_stage', arguments: { workspaceId } }))
		expect(deployed).toMatchObject({ appId: 'shop', env: 'stage', commitSha: sha('a') })
		expect(world.queued).toHaveLength(1)
	})
})

describe('the Worker console without the MCP table', () => {
	test('MCP is off: /mcp is the session-only row the service answers 404', async () => {
		const { fetch } = await fixture({ digest: controlServiceDigest({ mcp: false, cli: true }) })
		const response = await fetch(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
		expect(response.status).toBe(404)
	})

	test('a Worker that composes no MCP route refuses the MCP table instead of serving another one', () => {
		expect(() => workerControlApp({ FABRIKA_CONTROL_DOMAIN: 'other.example.com', FABRIKA_SERVICE_TABLE_DIGEST: MCP_TABLE })).toThrow(ControlTableError)
		expect(workerMcpRoute(undefined)).toBeNull()
	})
})

describe('the embedded skill', () => {
	test('parses what the deploy embeds, and refuses anything else', () => {
		expect(parseAppAgentSkill(embeddedSkill()).version).toBe(readAppAgentSkill().version)
		expect(() => parseAppAgentSkill('not json')).toThrow('not valid JSON')
		expect(() => parseAppAgentSkill('{"version":""}')).toThrow('not a skill')
	})

	test('a Worker judges only an exact pin', () => {
		expect(exactPinSatisfies('0.9.0-dev.41', '0.9.0-dev.41')).toBe(true)
		expect(exactPinSatisfies('0.9.0-dev.41', '=0.9.0-dev.40')).toBe(false)
		expect(exactPinSatisfies('0.9.0', '^0.9.0')).toBeNull()
		expect(exactPinSatisfies('0.9.0', 'workspace:*')).toBeNull()
	})
})

function toolJson(response: unknown): unknown {
	const result = field(response, 'result')
	expect(field(result, 'isError')).not.toBe(true)
	const content = field(result, 'content')
	if (!Array.isArray(content)) throw new Error('expected tool content')
	return JSON.parse(String(field(content[0], 'text')))
}

function field(value: unknown, name: string): unknown {
	if (typeof value !== 'object' || value === null || !(name in value)) return undefined
	return Object.entries(value).find(([key]) => key === name)?.[1]
}
