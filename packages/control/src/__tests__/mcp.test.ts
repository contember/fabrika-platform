// The `/mcp` endpoint over the Bun composition's fetch handler: OAuth resource-token authentication,
// the MCP wire protocol, and the tools reaching the workspace use cases.

import { readAppAgentSkill } from '@fabrika/app/agent-skill'
import { PROXY_TOKEN_HEADER } from '@fabrika/auth'
import { afterEach, describe, expect, test } from 'bun:test'
import { controlMcpResource, controlMcpResourceMetadata } from '../../fabrika.service'
import type { Env } from '../env'
import { controlMcpRoute } from '../zerops/mcp'
import { createFetchHandler } from '../zerops/server'
import { createHarness, type Harness } from './helpers/harness'
import { allowAllAuth } from './helpers/iam'
import { proxiedRequest } from './helpers/proxy'
import { unusedSourceConnection } from './helpers/source-connection'
import { adminToken, testIamEnv, testResourceToken } from './helpers/tokens'
import { AUTHOR_ACTIONS, seedWorkspaceWorld, sha, type WorkspaceWorld, zeropsProvider } from './helpers/workspaces'

const ORIGIN = 'https://console.example.com'
const RESOURCE = controlMcpResource(ORIGIN)

let harness: Harness | null = null
afterEach(() => {
	harness?.sqlite.close()
	harness = null
})

async function fixture(): Promise<{ world: WorkspaceWorld; fetch: (request: Request) => Promise<Response> }> {
	harness = createHarness()
	const world = await seedWorkspaceWorld(harness.repositories, harness.d1)
	// The world's queue and log reader stand in for the process ports.
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
		ENVIRONMENT: 'stage',
		FABRIKA_CONTROL_DOMAIN: ORIGIN,
	}
	const mcp = controlMcpRoute(env, world.source)
	const served = createFetchHandler(env, zeropsProvider, unusedSourceConnection('zerops'), mcp)
	return { world, fetch: (request) => served(proxiedRequest(request, { mcp: true })) }
}

function mcpRequest(body: unknown, token?: string): Request {
	const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' })
	if (token !== undefined) headers.set(PROXY_TOKEN_HEADER, token)
	return new Request(`${ORIGIN}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
}

async function rpc(fetch: (request: Request) => Promise<Response>, token: string, method: string, params: object): Promise<unknown> {
	const response = await fetch(mcpRequest({ jsonrpc: '2.0', id: 1, method, params }, token))
	expect(response.status).toBe(200)
	return readMessage(response)
}

/** A 2025-era client is answered over SSE; the JSON-RPC response is the last `data:` frame. */
async function readMessage(response: Response): Promise<unknown> {
	const text = await response.text()
	if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) return JSON.parse(text)
	const frames = text.split('\n').filter((line) => line.startsWith('data:'))
	const last = frames.at(-1)
	if (last === undefined) throw new Error('expected an SSE data frame')
	return JSON.parse(last.slice('data:'.length))
}

describe('the MCP endpoint', () => {
	test('a missing token gets 401 with the resource metadata challenge', async () => {
		const { fetch } = await fixture()
		const response = await fetch(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
		expect(response.status).toBe(401)
		expect(response.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${controlMcpResourceMetadata(ORIGIN)}"`)
	})

	test('a console token or a token for another resource is invalid here', async () => {
		const { fetch } = await fixture()
		const foreign = await testResourceToken({ resource: 'https://other.example.com/mcp', label: 'author@acme.test', actions: AUTHOR_ACTIONS })
		for (const token of [adminToken, foreign, 'not-a-jwt']) {
			const response = await fetch(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, token))
			expect(response.status).toBe(401)
			expect(response.headers.get('www-authenticate')).toBe(
				`Bearer resource_metadata="${controlMcpResourceMetadata(ORIGIN)}", error="invalid_token"`,
			)
		}
	})

	test('initialize answers the workspace flow and the critical rules within 2,000 characters', async () => {
		const { fetch } = await fixture()
		const token = await testResourceToken({ resource: RESOURCE, label: 'author@acme.test', actions: AUTHOR_ACTIONS })
		const initialized = await rpc(fetch, token, 'initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'test', version: '1.0.0' },
		})
		const instructions = String(field(field(initialized, 'result'), 'instructions'))
		expect(instructions.length).toBeLessThanOrEqual(2000)
		expect(instructions).toStartWith('Edit applications on Fabrika. A workspace is a Git branch')
		expect(instructions).toContain('Before editing an application, call get_app_rules and follow it.')
	})

	test('get_app_rules is read-only and answers the skill of @fabrika/app under its version, or one reference file by topic', async () => {
		const { fetch, world } = await fixture()
		const token = await testResourceToken({ resource: RESOURCE, label: 'author@acme.test', actions: AUTHOR_ACTIONS })
		const skill = readAppAgentSkill()
		const listed = field(field(await rpc(fetch, token, 'tools/list', {}), 'result'), 'tools')
		const tool = Array.isArray(listed) ? listed.find((entry) => field(entry, 'name') === 'get_app_rules') : undefined
		expect(field(tool, 'annotations')).toEqual({ readOnlyHint: true, openWorldHint: false })
		const properties = field(field(tool, 'inputSchema'), 'properties')
		expect(typeof properties === 'object' && properties !== null ? Object.keys(properties).sort() : []).toEqual(['topic', 'workspaceId'])

		const answered = field(await rpc(fetch, token, 'tools/call', { name: 'get_app_rules', arguments: {} }), 'result')
		expect(field(answered, 'isError')).not.toBe(true)
		expect(field(answered, 'content')).toEqual([{ type: 'text', text: `fabrika-app ${skill.version}\n\n${skill.body}` }])
		const endpoint = skill.references.find((reference) => reference.topic === 'endpoint')
		const byTopic = field(await rpc(fetch, token, 'tools/call', { name: 'get_app_rules', arguments: { topic: 'endpoint' } }), 'result')
		expect(field(byTopic, 'content')).toEqual([{ type: 'text', text: `fabrika-app ${skill.version}\n\n${endpoint?.text}` }])
		for (const refusedArguments of [{ path: 'x' }, { topic: 'unknown' }]) {
			const refused = field(await rpc(fetch, token, 'tools/call', { name: 'get_app_rules', arguments: refusedArguments }), 'result')
			expect(JSON.stringify(refused)).toContain('"isError":true')
		}
		expect(world.source.kinds()).toEqual([])
	})

	test("get_app_rules warns when the workspace's package.json pins another @fabrika/app", async () => {
		const { fetch, world } = await fixture()
		const token = await testResourceToken({ resource: RESOURCE, label: 'author@acme.test', actions: AUTHOR_ACTIONS })
		const version = readAppAgentSkill().version
		const workspace = toolJson(
			await rpc(fetch, token, 'tools/call', { name: 'create_workspace', arguments: { appId: 'shop', env: 'stage', title: 'Rules' } }),
		)
		const rulesFor = async (range: string): Promise<string> => {
			world.source.contents.set('package.json', JSON.stringify({ dependencies: { '@fabrika/app': range } }))
			const answered = field(
				await rpc(fetch, token, 'tools/call', { name: 'get_app_rules', arguments: { workspaceId: field(workspace, 'id') } }),
				'result',
			)
			return JSON.stringify(field(answered, 'content'))
		}
		expect(await rulesFor(`^${version}`)).not.toContain('Warning:')
		expect(await rulesFor('^99.0.0')).toContain(`Warning: this workspace pins @fabrika/app ^99.0.0, and these rules describe ${version}.`)
	})

	test('every tool tells the client whether it only reads, and how a write behaves', async () => {
		const { fetch } = await fixture()
		const token = await testResourceToken({ resource: RESOURCE, label: 'author@acme.test', actions: AUTHOR_ACTIONS })
		const tools = field(field(await rpc(fetch, token, 'tools/list', {}), 'result'), 'tools')
		if (!Array.isArray(tools)) throw new Error('expected a tool list')
		const annotations = Object.fromEntries(tools.map((tool) => [String(field(tool, 'name')), field(tool, 'annotations')]))
		const read = { readOnlyHint: true, openWorldHint: false }
		const write = (destructiveHint: boolean, idempotentHint: boolean) => ({
			readOnlyHint: false,
			destructiveHint,
			idempotentHint,
			openWorldHint: false,
		})
		expect(annotations).toEqual({
			get_app_rules: read,
			list_targets: read,
			create_workspace: write(false, false),
			list_workspaces: read,
			get_workspace: read,
			list_files: read,
			read_files: read,
			apply_changes: write(true, true),
			deploy_stage: write(true, false),
			get_deployment: read,
			create_pull_request: write(false, true),
		})
	})

	test('a resource token lists the tools and calls a read and a write tool', async () => {
		const { fetch, world } = await fixture()
		const token = await testResourceToken({ resource: RESOURCE, label: 'author@acme.test', actions: AUTHOR_ACTIONS })

		const listed = await rpc(fetch, token, 'tools/list', {})
		expect(toolNames(listed)).toEqual([
			'apply_changes',
			'create_pull_request',
			'create_workspace',
			'deploy_stage',
			'get_app_rules',
			'get_deployment',
			'get_workspace',
			'list_files',
			'list_targets',
			'list_workspaces',
			'read_files',
		])

		const targets = await rpc(fetch, token, 'tools/call', { name: 'list_targets', arguments: {} })
		expect(toolJson(targets)).toEqual({
			items: [{ appId: 'shop', env: 'stage', repository: 'acme/shop', defaultBranch: 'main', publicOrigin: 'https://shop-stage.example.com' }],
		})

		const created = await rpc(fetch, token, 'tools/call', { name: 'create_workspace', arguments: { appId: 'shop', env: 'stage', title: 'Banner' } })
		const workspace = toolJson(created)
		expect(workspace).toMatchObject({ appId: 'shop', env: 'stage', headSha: sha('a') })
		expect(world.source.kinds()).toEqual(['read-branch', 'create-branch'])

		world.source.contents.set('src/app.ts', 'title = "Old"')
		const edited = await rpc(fetch, token, 'tools/call', {
			name: 'apply_changes',
			arguments: {
				workspaceId: field(workspace, 'id'),
				expectedHeadSha: sha('a'),
				message: 'Retitle',
				changes: [{ path: 'src/app.ts', oldString: '"Old"', newString: '"New"' }],
			},
		})
		expect(toolJson(edited)).toEqual({ commitSha: sha('1') })
		expect(world.source.calls.at(-1)).toMatchObject({ kind: 'commit', commit: { changes: [{ path: 'src/app.ts', content: 'title = "New"' }] } })
	})

	test('a refused tool call is a tool error with a short message, and invalid input never reaches Source', async () => {
		const { fetch, world } = await fixture()
		const token = await testResourceToken({ resource: RESOURCE, label: 'author@acme.test', actions: AUTHOR_ACTIONS })
		const created = toolJson(
			await rpc(fetch, token, 'tools/call', {
				name: 'create_workspace',
				arguments: { appId: 'shop', env: 'stage', title: 'Banner' },
			}),
		)
		const workspaceId = typeof created === 'object' && created !== null && 'id' in created ? created.id : null
		const refused = await rpc(fetch, token, 'tools/call', {
			name: 'apply_changes',
			arguments: { workspaceId, expectedHeadSha: sha('a'), message: 'm', changes: [{ path: 'zerops.yaml', content: 'x' }] },
		})
		expect(refused).toMatchObject({
			result: { isError: true, content: [{ type: 'text', text: 'protected paths cannot be changed through a workspace: zerops.yaml' }] },
		})
		const pinned = await rpc(fetch, token, 'tools/call', { name: 'deploy_stage', arguments: { workspaceId, commitSha: sha('b') } })
		expect(JSON.stringify(pinned)).toContain('"isError":true')
		for (const change of [{ path: 'a.ts', oldString: '', newString: 'x' }, { path: 'a.ts', oldString: 'x', content: 'y' }]) {
			const malformed = await rpc(fetch, token, 'tools/call', {
				name: 'apply_changes',
				arguments: { workspaceId, expectedHeadSha: sha('a'), message: 'm', changes: [change] },
			})
			expect(JSON.stringify(malformed)).toContain('"isError":true')
		}
		const oversized = await rpc(fetch, token, 'tools/call', {
			name: 'apply_changes',
			arguments: { workspaceId, expectedHeadSha: sha('a'), message: 'm', changes: [{ path: 'big.txt', content: 'é'.repeat(256 * 1024 + 1) }] },
		})
		expect(JSON.stringify(oversized)).toContain('"isError":true')
		expect(world.source.kinds()).toEqual(['read-branch', 'create-branch'])
		expect(world.queued).toEqual([])
	})

	test('an OAuth resource token is refused on the console RPC surface', async () => {
		const { fetch } = await fixture()
		const token = await testResourceToken({ resource: RESOURCE, label: 'author@acme.test', actions: ['*'] })
		const response = await fetch(
			new Request(`${ORIGIN}/api/rpc`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [PROXY_TOKEN_HEADER]: token },
				body: JSON.stringify({ method: 'apps.list', input: null }),
			}),
		)
		expect(response.status).toBe(401)
	})

	test('other paths still reach the console application', async () => {
		const { fetch } = await fixture()
		const health: unknown = await (await fetch(new Request(`${ORIGIN}/healthz`))).json()
		expect(health).toEqual({ status: 'ok' })
	})
})

function toolNames(response: unknown): string[] {
	const tools = field(field(response, 'result'), 'tools')
	if (!Array.isArray(tools)) throw new Error('expected a tool list')
	return tools.map((tool) => String(field(tool, 'name'))).sort()
}

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
