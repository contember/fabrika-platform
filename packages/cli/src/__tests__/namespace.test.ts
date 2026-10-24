import { createZeropsArtifactSourceDescriptor } from '@fabrika/provider-zerops'
import { appCli } from '@fabrika/provider-zerops/cli'
import { describe, expect, test } from 'bun:test'
import { type NamespaceCommandDependencies, runNamespaceCommand } from '../namespace'

const zeropsNamespaces = appCli.namespaces
if (zeropsNamespaces === undefined) throw new Error('the Zerops CLI module declares no namespace commands')

interface Command {
	readonly subcommand: string
	readonly argv: readonly string[]
}

const command = (subcommand: string, argv: readonly string[]): Command => ({ subcommand, argv })

/** The Zerops commands through this area's runner: the provider plans, the runner calls Control and prints. */
const runZerops = (run: Command, deps: NamespaceCommandDependencies): Promise<void> =>
	runNamespaceCommand(zeropsNamespaces, run.subcommand, run.argv, deps)

interface Call {
	readonly url: string
	readonly method: string
	readonly authorization: string | null
	readonly body: string | null
	readonly redirect: RequestRedirect | undefined
}

const proxySource = {
	repository: { owner: 'contember', name: 'fabrika-platform' },
	commitSha: 'a'.repeat(40),
	descriptor: await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: proxy\n    run:\n      start: ./proxy\n'),
}

const source = (): Record<string, string | undefined> => ({
	FABRIKA_ZEROPS_PROXY_SOURCE_JSON: JSON.stringify(proxySource),
	FABRIKA_CONTROL_URL: 'https://control.example.test',
	FABRIKA_CONTROL_TOKEN: 'px_operator_secret',
})

const recorder = (calls: Call[], status = 200) => (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
	const headers = new Headers(init?.headers)
	calls.push({
		url: input instanceof Request ? input.url : input.toString(),
		method: init?.method ?? 'GET',
		authorization: headers.get('authorization'),
		body: typeof init?.body === 'string' ? init.body : null,
		redirect: init?.redirect,
	})
	return Promise.resolve(
		new Response(
			status >= 400
				? JSON.stringify({ error: { type: 'error', message: 'namespace request failed' } })
				: JSON.stringify({ result: { id: 'namespace', env: 'prod', state: 'ready', exclusiveAppId: null } }),
			{ status, headers: { 'content-type': 'application/json' } },
		),
	)
}

describe('fabrika namespace commands', () => {
	test('unwraps RPC results and rejects malformed success or HTTP failure', async () => {
		const args = command('reconcile', ['--id=apps-prod', '--json'])
		const output: string[] = []
		await runZerops(args, { source: source(), fetch: recorder([]), write: (value) => output.push(value) })
		expect(JSON.parse(output.join(''))).toEqual({ id: 'namespace', env: 'prod', state: 'ready', exclusiveAppId: null })
		for (
			const response of [
				Response.json({}),
				Response.json({ result: null }),
				Response.json({ result: { id: 'x', env: 'prod', state: 'bogus', exclusiveAppId: null } }),
				Response.json({ result: { id: 'x', state: 'ready' } }),
				Response.json({ result: { id: 'x', state: 'ready' } }, { status: 503 }),
			]
		) {
			const failedOutput: string[] = []
			await expect(runZerops(args, { source: source(), fetch: async () => response, write: (value) => failedOutput.push(value) }))
				.rejects.toThrow()
			expect(failedOutput).toEqual([])
		}
	})
	test('plans cheap topology offline with explicit provider fields', async () => {
		const calls: Call[] = []
		const output: string[] = []
		await runZerops(
			command('plan', ['--id=apps-prod', '--env=prod', '--preset=cheap', '--json']),
			{ source: source(), fetch: recorder(calls), write: (value) => output.push(value) },
		)

		expect(calls).toEqual([])
		const plan: {
			namespace: { target: { payload: { projectName: string; corePackage: string; postgres: { type: string } } } }
			presentation: { preset: string }
		} = JSON.parse(output.join(''))
		expect(plan.namespace.target.payload).toMatchObject({
			projectName: 'fabrika-prod-apps-prod',
			corePackage: 'LIGHT',
			postgres: { type: 'postgresql:single@18' },
			proxySource,
		})
		expect(plan.presentation.preset).toBe('cheap')
	})

	test('prints a plan as one row per field, the descriptor by size only', async () => {
		const output: string[] = []
		await runZerops(
			command('plan', ['--id=apps-prod', '--env=prod', '--preset=cheap']),
			{ source: source(), fetch: recorder([]), write: (value) => output.push(value) },
		)

		const rows = output.join('').trimEnd().split('\n')
		expect(rows).toContain('namespace.id\tapps-prod')
		expect(rows).toContain('namespace.env\tprod')
		expect(rows).toContain('namespace.target.payload.projectName\tfabrika-prod-apps-prod')
		expect(rows).toContain('presentation.preset\tcheap')
		const descriptorBytes = new TextEncoder().encode(proxySource.descriptor.contents).byteLength
		expect(rows).toContain(`namespace.target.payload.proxySource.descriptor.contents\t(${descriptorBytes} bytes; --json prints it)`)
		expect(output.join('')).not.toContain('{')
	})

	test('prints the namespace Control answers as one row', async () => {
		const output: string[] = []
		await runZerops(command('reconcile', ['--id=apps-prod']), {
			source: source(),
			fetch: recorder([]),
			write: (value) => output.push(value),
		})

		expect(output.join('')).toBe('namespace\tprod\tready\t-\n')
	})

	test('takes --json and --control-url out before the provider parser, which refuses unknown options', async () => {
		const calls: Call[] = []
		const output: string[] = []
		const deps = { source: { ...source(), FABRIKA_CONTROL_URL: undefined }, fetch: recorder(calls), write: (value: string) => output.push(value) }
		await runZerops(command('reconcile', ['--id=apps-prod', '--json', '--control-url=https://other.example.test']), deps)
		expect(calls.map((call) => call.url)).toEqual(['https://other.example.test/api/rpc'])
		expect(JSON.parse(output.join(''))).toMatchObject({ id: 'namespace' })
		await expect(runZerops(command('plan', ['--yaml']), deps)).rejects.toThrow('Unknown option: --yaml')
	})

	test('creates a full namespace through the control API', async () => {
		const calls: Call[] = []
		await runZerops(
			command('create', ['--id=billing-prod', '--env=prod', '--preset=full', '--exclusive-app=billing']),
			{ source: source(), fetch: recorder(calls), write: () => {} },
		)

		expect(calls).toHaveLength(1)
		expect(calls[0]).toMatchObject({
			url: 'https://control.example.test/api/rpc',
			method: 'POST',
			authorization: 'Bearer px_operator_secret',
			redirect: 'manual',
		})
		const body: { method: string; input: { id: string; env: string; exclusiveAppId: string; target: { payload: { postgres?: unknown } } } } = JSON
			.parse(calls[0]?.body ?? '')
		expect(body.method).toBe('namespaces.create')
		expect(body.input).toMatchObject({ id: 'billing-prod', env: 'prod', exclusiveAppId: 'billing' })
		expect(body.input.target.payload.postgres).toBeUndefined()
		expect(body.input.target.payload).toMatchObject({ proxySource })
	})

	test('adopts an existing project and reconciles by namespace id', async () => {
		const calls: Call[] = []
		const deps = { source: source(), fetch: recorder(calls), write: () => {} }
		await runZerops(
			command('adopt', ['--id=legacy-prod', '--env=prod', '--preset=mid', '--project-id=project-1']),
			deps,
		)
		await runZerops(
			command('reconcile', ['--id=legacy-prod']),
			deps,
		)

		expect(calls.map((call) => call.url)).toEqual([
			'https://control.example.test/api/rpc',
			'https://control.example.test/api/rpc',
		])
		const adopted: { method: string; input: { namespaceId: string; namespace: { target: { payload: { managed: boolean; projectId: string } } } } } =
			JSON.parse(
				calls[0]?.body ?? '',
			)
		expect(adopted.method).toBe('namespaces.adopt')
		expect(adopted.input.namespaceId).toBe('legacy-prod')
		expect(adopted.input.namespace.target.payload).toMatchObject({ managed: false, projectId: 'project-1', projectName: 'legacy-prod', proxySource })
		expect(JSON.parse(calls[1]?.body ?? '')).toEqual({ method: 'namespaces.reconcile', input: { namespaceId: 'legacy-prod' } })
	})

	test('rejects missing coordinates and credentials before fetch', async () => {
		const calls: Call[] = []
		const args = command('create', ['--id=apps-prod', '--env=prod'])
		await expect(runZerops(args, {
			source: {},
			fetch: recorder(calls),
			write: () => {},
		})).rejects.toThrow('FABRIKA_ZEROPS_PROXY_SOURCE_JSON is required')
		await expect(runZerops(command('reconcile', ['--id=apps-prod']), { source: {}, fetch: recorder(calls), write: () => {} }))
			.rejects.toThrow('--control-url or FABRIKA_CONTROL_URL is required')
		await expect(runZerops(command('reconcile', ['--id=apps-prod']), {
			source: { FABRIKA_CONTROL_URL: 'https://control.example.test' },
			fetch: recorder(calls),
			write: () => {},
		})).rejects.toThrow('FABRIKA_CONTROL_TOKEN is required')
		expect(calls).toEqual([])
	})

	test('rejects malformed or mismatched immutable sources before output or network', async () => {
		for (const subcommand of ['plan', 'create', 'adopt']) {
			for (
				const serialized of [
					'{"secret-input":',
					'null',
					JSON.stringify({ ...proxySource, commitSha: 'main' }),
					JSON.stringify({ ...proxySource, descriptor: { ...proxySource.descriptor, sha256: '0'.repeat(64) } }),
				]
			) {
				const calls: Call[] = []
				const output: string[] = []
				const args = command(subcommand, ['--id=apps-prod', '--env=prod', '--preset=cheap', '--project-id=project-1'])
				await expect(runZerops(args, {
					source: { ...source(), FABRIKA_ZEROPS_PROXY_SOURCE_JSON: serialized },
					fetch: recorder(calls),
					write: (value) => output.push(value),
				})).rejects.toThrow()
				expect(calls).toEqual([])
				expect(output).toEqual([])
			}
		}
	})

	test('reconciles the persisted target without selecting a local source', async () => {
		for (const serialized of [undefined, 'invalid unused JSON']) {
			const calls: Call[] = []
			await runZerops(command('reconcile', ['--id=apps-prod']), {
				source: { ...source(), FABRIKA_ZEROPS_PROXY_SOURCE_JSON: serialized },
				fetch: recorder(calls),
				write: () => {},
			})
			expect(calls).toHaveLength(1)
			expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ method: 'namespaces.reconcile', input: { namespaceId: 'apps-prod' } })
		}
	})

	test('does not include the Bearer credential in API failures', async () => {
		const calls: Call[] = []
		const output: string[] = []
		try {
			await runZerops(
				command('reconcile', ['--id=apps-prod']),
				{ source: source(), fetch: recorder(calls, 502), write: (value) => output.push(value) },
			)
			throw new Error('namespace command unexpectedly succeeded')
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause)
			expect(message).toContain('namespace request failed')
			expect(message).not.toContain('px_operator_secret')
		}
		expect(output.join('')).not.toContain('px_operator_secret')
	})
})
