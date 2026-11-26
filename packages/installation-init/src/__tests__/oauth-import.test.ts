import type { ImportOAuthClientsResponse } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { createIamAdminClient } from '../admin'
import type { McpClient } from '../mcp'
import { importOAuthClientsOnce, type OAuthClientImport } from '../oauth-import'

const ORIGIN = 'https://iam.example.test'
const KEY = 'px_provisioning_secret'
const VARIABLE = 'FABRIKA_PLATFORM_MCP_CLIENTS_JSON'

const OPS_TOOL: McpClient = {
	provider: 'external',
	clientId: 'https://ops.example.test/oauth/client.json',
	redirectUris: ['https://ops.example.test/oauth/callback'],
	identity: { app: 'ops-tool', resource: 'https://ops.example.test', roles: [{ key: 'viewer', name: 'Viewer' }] },
}

interface Recorded {
	readonly url: string
	readonly method: string
	readonly input: unknown
	readonly authorization: string | null
	readonly redirect: RequestRedirect | undefined
}

/** IAM's `/admin/rpc` over the real wire envelope, answering `importOnce` with `answer`. */
const fakeIam = (answer: () => Response) => {
	const calls: Recorded[] = []
	const lines: { level: 'info' | 'warn'; message: string }[] = []
	const run = (overrides: Partial<OAuthClientImport> = {}) =>
		importOAuthClientsOnce({
			clients: [OPS_TOOL],
			variable: VARIABLE,
			dryRun: false,
			connect: () =>
				createIamAdminClient({
					origin: ORIGIN,
					provisioningKey: KEY,
					fetch: async (input, init) => {
						const body: unknown = JSON.parse(String(init?.body ?? '{}'))
						calls.push({
							url: String(input),
							method: String(Reflect.get(Object(body), 'method')),
							input: Reflect.get(Object(body), 'input'),
							authorization: new Headers(init?.headers).get('authorization'),
							redirect: init?.redirect,
						})
						return answer()
					},
				}),
			log: { info: (message) => void lines.push({ level: 'info', message }), warn: (message) => void lines.push({ level: 'warn', message }) },
			...overrides,
		})
	return { calls, lines, run }
}

const result = (value: ImportOAuthClientsResponse) => () => Response.json({ result: value })

describe("the deploy's one import of the OAuth client list", () => {
	test("sends the variable's entries with the provisioning key as the bearer, never following a redirect, reports the import and warns", async () => {
		const iam = fakeIam(result({ status: 'imported', externalApps: ['ops-tool'], oauthClients: [OPS_TOOL.clientId] }))
		await iam.run()
		expect(iam.calls).toEqual([{
			url: `${ORIGIN}/admin/rpc`,
			method: 'oauthClients.importOnce',
			input: { clients: [OPS_TOOL] },
			authorization: `Bearer ${KEY}`,
			redirect: 'manual',
		}])
		expect(iam.lines[0]).toEqual({
			level: 'info',
			message: 'IAM imported the OAuth client list: 1 external application(s) (ops-tool), 1 client(s); it serves its registry from now on',
		})
		// The importing deploy warns too: every deploy does while the variable is set.
		expect(iam.lines).toHaveLength(2)
		expect(iam.lines[1]?.level).toBe('warn')
		expect(iam.lines[1]?.message).toStartWith(`${VARIABLE} imported; this release no longer reads the variable after the import`)
		expect(iam.lines[1]?.message).toContain('Delete it once this release is accepted')
	})

	test('an unset variable imports an empty list, which still marks the registry imported', async () => {
		const iam = fakeIam(result({ status: 'imported', externalApps: [], oauthClients: [] }))
		await iam.run({ clients: undefined })
		expect(iam.calls.map((call) => call.input)).toEqual([{ clients: [] }])
		expect(iam.lines.map((line) => line.level)).toEqual(['info'])
	})

	test('already imported with the variable still set: says so once and warns that the variable should be deleted', async () => {
		const iam = fakeIam(result({ status: 'already_imported' }))
		await iam.run()
		expect(iam.lines).toHaveLength(2)
		expect(iam.lines[0]).toEqual({ level: 'info', message: "IAM's registry was imported by an earlier deploy; nothing was written" })
		expect(iam.lines[1]?.level).toBe('warn')
		expect(iam.lines[1]?.message).toStartWith(`${VARIABLE} this release no longer reads the variable after the import`)
		expect(iam.lines[1]?.message).toContain('Delete it once this release is accepted')
	})

	test('already imported without the variable: no warning', async () => {
		const iam = fakeIam(result({ status: 'already_imported' }))
		await iam.run({ clients: undefined })
		expect(iam.lines.map((line) => line.level)).toEqual(['info'])
	})

	test("IAM's refusal fails the deploy with IAM's wording, never the key", async () => {
		const iam = fakeIam(() => Response.json({ error: { type: 'validation', message: 'clients[0] is not a valid managed client' } }, { status: 400 }))
		const failure = await iam.run().then(() => undefined, (error: unknown) => error)
		expect(failure).toBeInstanceOf(Error)
		const message = failure instanceof Error ? failure.message : ''
		expect(message).toBe('oauthClients.importOnce failed: clients[0] is not a valid managed client (HTTP 400)')
		expect(message).not.toContain(KEY)
	})

	test('an unreachable IAM, an IAM without the procedure, and an answer of another shape all fail the deploy', async () => {
		const unreachable = fakeIam(() => {
			throw new TypeError('connection refused')
		})
		await expect(unreachable.run()).rejects.toThrow('oauthClients.importOnce failed')
		const older = fakeIam(() => Response.json({ error: { type: 'not_found', message: 'unknown procedure' } }, { status: 404 }))
		await expect(older.run()).rejects.toThrow('oauthClients.importOnce failed: unknown procedure (HTTP 404)')
		const empty = fakeIam(() => Response.json({}))
		await expect(empty.run()).rejects.toThrow('answered no result')
		const other = fakeIam(() => Response.json({ result: { status: 'done' } }))
		await expect(other.run()).rejects.toThrow('answered neither imported nor already_imported')
	})

	test('a dry run calls nothing and says what it would do', async () => {
		const iam = fakeIam(() => {
			throw new Error('called')
		})
		const connect = () => {
			throw new Error('a dry run connected to IAM')
		}
		await iam.run({ dryRun: true, connect })
		expect(iam.calls).toEqual([])
		expect(iam.lines).toEqual([{
			level: 'info',
			message: `would import 1 OAuth client(s) from ${VARIABLE} into IAM's registry, unless an earlier deploy already did`,
		}])
		await iam.run({ dryRun: true, clients: undefined, connect })
		expect(iam.lines[1]?.message).toBe(`would import nothing (${VARIABLE} is unset) into IAM's registry, unless an earlier deploy already did`)
	})
})
