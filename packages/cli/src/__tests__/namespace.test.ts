import { createZeropsArtifactSourceDescriptor, parseZeropsCliArgs } from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { runZeropsNamespaceCommand } from '../namespace'

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
				: JSON.stringify({ result: { id: 'namespace', state: 'ready' } }),
			{ status, headers: { 'content-type': 'application/json' } },
		),
	)
}

describe('fabrika namespace commands', () => {
	test('unwraps RPC results and rejects malformed success or HTTP failure', async () => {
		const args = parseZeropsCliArgs(['namespace', 'reconcile', '--id=apps-prod'])
		const output: string[] = []
		await runZeropsNamespaceCommand(args, { source: source(), fetch: recorder([]), write: (value) => output.push(value) })
		expect(JSON.parse(output.join(''))).toEqual({ id: 'namespace', state: 'ready' })
		for (
			const response of [
				Response.json({}),
				Response.json({ result: null }),
				Response.json({ result: { id: 'x', state: 'bogus' } }),
				Response.json({ result: { id: 'x', state: 'ready' } }, { status: 503 }),
			]
		) {
			const failedOutput: string[] = []
			await expect(runZeropsNamespaceCommand(args, { source: source(), fetch: async () => response, write: (value) => failedOutput.push(value) }))
				.rejects.toThrow()
			expect(failedOutput).toEqual([])
		}
	})
	test('plans cheap topology offline with explicit provider fields', async () => {
		const calls: Call[] = []
		const output: string[] = []
		await runZeropsNamespaceCommand(
			parseZeropsCliArgs(['namespace', 'plan', '--id=apps-prod', '--env=prod', '--preset=cheap']),
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

	test('creates a full namespace through the control API', async () => {
		const calls: Call[] = []
		await runZeropsNamespaceCommand(
			parseZeropsCliArgs([
				'namespace',
				'create',
				'--id=billing-prod',
				'--env=prod',
				'--preset=full',
				'--exclusive-app=billing',
			]),
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
		await runZeropsNamespaceCommand(
			parseZeropsCliArgs([
				'namespace',
				'adopt',
				'--id=legacy-prod',
				'--env=prod',
				'--preset=mid',
				'--project-id=project-1',
			]),
			deps,
		)
		await runZeropsNamespaceCommand(
			parseZeropsCliArgs(['namespace', 'reconcile', '--id=legacy-prod']),
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
		const args = parseZeropsCliArgs(['namespace', 'create', '--id=apps-prod', '--env=prod'])
		await expect(runZeropsNamespaceCommand(args, {
			source: {},
			fetch: recorder(calls),
			write: () => {},
		})).rejects.toThrow('FABRIKA_ZEROPS_PROXY_SOURCE_JSON is required')
		expect(calls).toEqual([])
	})

	test('rejects malformed or mismatched immutable sources before output or network', async () => {
		for (const command of ['plan', 'create', 'adopt']) {
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
				const args = parseZeropsCliArgs(['namespace', command, '--id=apps-prod', '--env=prod', '--preset=cheap', '--project-id=project-1'])
				await expect(runZeropsNamespaceCommand(args, {
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
			await runZeropsNamespaceCommand(parseZeropsCliArgs(['namespace', 'reconcile', '--id=apps-prod']), {
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
			await runZeropsNamespaceCommand(
				parseZeropsCliArgs(['namespace', 'reconcile', '--id=apps-prod']),
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
