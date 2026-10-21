/**
 * MCP authoring end to end, in one process (ADR-0049): a client discovers the console's MCP resource,
 * runs OAuth against the real IAM application, passes the real proxy decision, and drives every tool
 * of the real Control endpoint, whose Git reads and writes run through its real workspace source with
 * the App key from its vault. Only the client's CIMD document, the GitHub repository and the Caddy hop
 * are stand-ins — see `mcp-authoring/stack.ts`.
 *
 * It lives OUTSIDE `src/` for the reason `console-access-plane.test.ts` does: `tsconfig.json` includes
 * `src/**` only, and Control's MCP graph needs the Cloudflare ambient types this package does not load.
 */

import { PROXY_TOKEN_HEADER } from '@fabrika/auth-core'
import { controlMcpResourceMetadata } from '@fabrika/control/service'
import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { proxiedRequest } from '../../control/src/__tests__/helpers/proxy'
import { type AuthorizationServer, authorize, callTool, discover, jwtHeader, mcpRequest, rpc, toolJson } from './mcp-authoring/client'
import { AUTHORING_GRANTS, CONSOLE, createMcpStack, type McpStack, RESOURCE } from './mcp-authoring/stack'

const MCP = `${CONSOLE}/mcp`
const METADATA = controlMcpResourceMetadata(CONSOLE)

const workspaceSchema = z.object({ id: z.string(), branch: z.string(), baseSha: z.string(), headSha: z.string() })
const treeSchema = z.object({ commitSha: z.string(), truncated: z.boolean(), entries: z.array(z.unknown()) })
const commitSchema = z.object({ commitSha: z.string() })
const runSchema = z.object({ id: z.string(), ref: z.string(), commitSha: z.string(), status: z.string() })
const pullRequestSchema = z.object({ number: z.number(), url: z.string(), created: z.boolean() })
const toolListSchema = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })

let stack: McpStack | null = null
afterEach(async () => {
	await stack?.stop()
	stack = null
})

async function signedInClient(current: McpStack, server: AuthorizationServer, email: string, grants: readonly string[]): Promise<string> {
	const person = await current.addPerson(email, grants)
	const token = await authorize(current.internet, server, { clientId: current.clientId, resource: RESOURCE, session: person.session })
	return token.access_token
}

describe('MCP authoring through IAM, the proxy and Control', () => {
	test('a client authorizes, edits a workspace, deploys it to stage and opens a pull request', async () => {
		const current = await createMcpStack()
		stack = current
		const { internet, repository, world } = current
		const call = (token: string, name: string, args: object) => callTool(internet, MCP, token, name, args)

		// The proxy refuses an anonymous call and points at the resource metadata, which names IAM.
		const anonymous = await internet(mcpRequest(MCP, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
		expect(anonymous.status).toBe(401)
		expect(anonymous.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${METADATA}"`)
		const { resource, server } = await discover(internet, METADATA)
		expect(resource).toBe(RESOURCE)

		const person = await current.addPerson('author@acme.test', AUTHORING_GRANTS)
		const issued = await authorize(internet, server, { clientId: current.clientId, resource, session: person.session })
		expect(jwtHeader(issued.access_token)).toMatchObject({ typ: 'at+jwt', alg: 'ES256' })
		expect(issued).toMatchObject({ token_type: 'Bearer', scope: 'authoring' })
		const token = issued.access_token

		// The proxy verifies the bearer against IAM's JWKS and injects it for Control.
		const decision = await current.decide(mcpRequest(MCP, {}, token))
		expect(decision.status).toBe(204)
		expect(decision.headers.get(PROXY_TOKEN_HEADER)).toBe(token)

		const initialized = await rpc(internet, MCP, token, 'initialize', {
			protocolVersion: '2025-11-25',
			capabilities: {},
			clientInfo: { name: 'witness', version: '1.0.0' },
		})
		expect(initialized).toMatchObject({ result: { protocolVersion: '2025-11-25', serverInfo: {} } })
		const tools = toolListSchema.parse(await rpc(internet, MCP, token, 'tools/list', {})).result.tools.map((tool) => tool.name).sort()
		expect(tools).toEqual([
			'apply_changes',
			'create_pull_request',
			'create_workspace',
			'deploy_stage',
			'get_app_rules',
			'get_deployment',
			'get_workspace',
			'get_workspace_diff',
			'list_files',
			'list_targets',
			'list_workspaces',
			'read_files',
			'search_files',
		])

		expect(toolJson(await call(token, 'list_targets', {}), z.unknown())).toEqual({
			items: [{ appId: 'shop', env: 'stage', repository: 'acme/shop', defaultBranch: 'main', publicOrigin: 'https://shop-stage.example.com' }],
		})

		const mainSha = repository.branches.get('main')
		const workspace = toolJson(await call(token, 'create_workspace', { appId: 'shop', env: 'stage', title: 'Greeting' }), workspaceSchema)
		expect(workspace.branch).toBe(`fabrika/${workspace.id}`)
		expect(workspace.headSha).toBe(mainSha ?? '')
		expect(repository.branches.get(workspace.branch)).toBe(workspace.headSha)
		expect(repository.opened.every((opened) => opened.installationId === 45 && opened.owner === 'acme' && opened.repository === 'shop')).toBe(true)

		const listing = toolJson(await call(token, 'list_files', { workspaceId: workspace.id }), treeSchema)
		expect(listing).toMatchObject({ commitSha: workspace.headSha, truncated: false })
		expect(listing.entries).toEqual(expect.arrayContaining([
			{ path: 'src', kind: 'directory' },
			{ path: 'src/index.ts', kind: 'file', size: 32 },
			{ path: 'zerops.yaml', kind: 'file', size: 11 },
		]))
		expect(toolJson(await call(token, 'read_files', { workspaceId: workspace.id, paths: ['src/index.ts', 'missing.ts'] }), z.unknown())).toEqual({
			commitSha: workspace.headSha,
			files: [{ path: 'src/index.ts', content: "export const greeting = 'hello'\n" }, { path: 'missing.ts', content: null, reason: 'missing' }],
		})

		const edit = { path: 'src/index.ts', content: "export const greeting = 'ahoj'\n" }
		const committed = toolJson(
			await call(token, 'apply_changes', { workspaceId: workspace.id, expectedHeadSha: workspace.headSha, message: 'Say ahoj', changes: [edit] }),
			commitSchema,
		)
		expect(repository.branches.get(workspace.branch)).toBe(committed.commitSha)
		const commit = repository.commit(committed.commitSha)
		expect(commit.parent).toBe(workspace.headSha)
		expect(commit.files.get('src/index.ts')).toBe(edit.content)
		expect(commit.message).toBe(`Say ahoj\n\nFabrika-Principal: ${person.principalId}\nFabrika-Client: ${current.clientId}`)
		expect(commit.author).toEqual({ name: 'author@acme.test', email: `${person.principalId}@users.noreply.fabrika` })
		expect(repository.branches.get('main')).toBe(mainSha ?? '')

		// A write against the old head is refused and names the head to re-read at.
		const stale = await call(token, 'apply_changes', {
			workspaceId: workspace.id,
			expectedHeadSha: workspace.headSha,
			message: 'Late edit',
			changes: [{ path: 'src/index.ts', content: 'late\n' }],
		})
		expect(stale).toEqual({
			isError: true,
			text: `the workspace head moved to ${committed.commitSha}; re-read the files at that commit and retry with expectedHeadSha ${committed.commitSha}`,
		})

		const commitsBefore = repository.commits.size
		const protectedEdit = await call(token, 'apply_changes', {
			workspaceId: workspace.id,
			expectedHeadSha: committed.commitSha,
			message: 'Change the build',
			changes: [{ path: 'zerops.yaml', content: 'zerops: [changed]\n' }],
		})
		expect(protectedEdit).toEqual({ isError: true, text: 'protected paths cannot be changed through a workspace: zerops.yaml' })
		expect(repository.commits.size).toBe(commitsBefore)
		expect(repository.branches.get(workspace.branch)).toBe(committed.commitSha)

		const run = toolJson(await call(token, 'deploy_stage', { workspaceId: workspace.id }), runSchema)
		expect(run).toMatchObject({ ref: `refs/heads/${workspace.branch}`, commitSha: committed.commitSha, status: 'pending' })
		const stored = await world.repositories.runs.getRun(run.id)
		expect(stored).toMatchObject({
			app_id: 'shop',
			env: 'stage',
			ref: `refs/heads/${workspace.branch}`,
			commit_sha: committed.commitSha,
			status: 'pending',
		})
		expect(world.queued).toEqual([{ runId: run.id }])

		expect(toolJson(await call(token, 'get_deployment', { runId: run.id }), z.unknown())).toMatchObject({
			run: { id: run.id, commitSha: committed.commitSha, status: 'pending' },
			log: { lines: [], from: 0, to: 0, total: 0 },
		})

		const opened = toolJson(
			await call(token, 'create_pull_request', { workspaceId: workspace.id, title: 'Say ahoj', body: 'Changed from Claude.' }),
			pullRequestSchema,
		)
		expect(opened).toEqual({ number: 1, url: 'https://github.com/acme/shop/pull/1', created: true })
		expect(repository.pullRequests).toEqual([{ number: 1, head: workspace.branch, base: 'main', title: 'Say ahoj', body: 'Changed from Claude.' }])
		const again = toolJson(
			await call(token, 'create_pull_request', { workspaceId: workspace.id, title: 'Say ahoj', body: 'Changed from Claude.' }),
			pullRequestSchema,
		)
		expect(again).toEqual({ number: 1, url: 'https://github.com/acme/shop/pull/1', created: false })
		expect(repository.pullRequests).toHaveLength(1)
	})

	test("a person without grants sees no target and cannot reach another person's workspace", async () => {
		const current = await createMcpStack()
		stack = current
		const { server } = await discover(current.internet, METADATA)
		const author = await signedInClient(current, server, 'author@acme.test', AUTHORING_GRANTS)
		const outsider = await signedInClient(current, server, 'outsider@acme.test', [])

		const workspace = toolJson(
			await callTool(current.internet, MCP, author, 'create_workspace', { appId: 'shop', env: 'stage', title: 'Mine' }),
			workspaceSchema,
		)
		expect(toolJson(await callTool(current.internet, MCP, outsider, 'list_targets', {}), z.unknown())).toEqual({ items: [] })
		expect(await callTool(current.internet, MCP, outsider, 'get_workspace', { workspaceId: workspace.id })).toEqual({
			isError: true,
			text: 'workspace not found',
		})
		expect(await callTool(current.internet, MCP, outsider, 'create_workspace', { appId: 'shop', env: 'stage', title: 'Theirs' })).toEqual({
			isError: true,
			text: 'authoring target not found',
		})
	})

	test('a native console token is refused at /mcp by the proxy and by Control', async () => {
		const current = await createMcpStack()
		stack = current
		const person = await current.addPerson('author@acme.test', AUTHORING_GRANTS)
		const minted = await current.proxyIam.mintToken({ app: 'vozka', session: person.session, requestId: 'witness' })
		if (!minted.ok) throw new Error(`the console token was not minted: ${minted.reason}`)
		expect(jwtHeader(minted.token)).not.toMatchObject({ typ: 'at+jwt' })

		const atProxy = await current.internet(mcpRequest(MCP, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, minted.token))
		expect(atProxy.status).toBe(401)
		expect(atProxy.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${METADATA}", error="invalid_token"`)

		// As if the proxy had admitted it: Control's own audience check still refuses the token.
		const direct = proxiedRequest(mcpRequest(MCP, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), { mcp: true })
		direct.headers.set(PROXY_TOKEN_HEADER, minted.token)
		const atControl = await current.control(direct)
		expect(atControl.status).toBe(401)
		expect(atControl.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${METADATA}", error="invalid_token"`)
	})
})
