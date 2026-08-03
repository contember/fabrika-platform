import { describe, expect, test } from 'bun:test'
import { parseZeropsCliArgs } from '../cli-args'
import { runZeropsNamespaceCommand } from '../namespace-command'

interface Call {
	readonly url: string
	readonly method: string
	readonly authorization: string | null
	readonly body: string | null
}

const source = (): Record<string, string | undefined> => ({
	FABRIKA_ZEROPS_PROXY_BUILD_FROM_GIT: 'https://github.com/contember/fabrika-platform',
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
	})
	return Promise.resolve(
		new Response(
			status >= 400 ? JSON.stringify({ error: 'namespace request failed' }) : JSON.stringify({ state: 'ready' }),
			{ status, headers: { 'content-type': 'application/json' } },
		),
	)
}

describe('fabrika namespace commands', () => {
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
			projectName: 'apps-prod',
			corePackage: 'SERIOUS',
			postgres: { type: 'postgresql:ha@18' },
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
			url: 'https://control.example.test/api/namespaces',
			method: 'POST',
			authorization: 'Bearer px_operator_secret',
		})
		const body: { id: string; env: string; exclusiveAppId: string; target: { payload: { postgres?: unknown } } } = JSON.parse(calls[0]?.body ?? '')
		expect(body).toMatchObject({ id: 'billing-prod', env: 'prod', exclusiveAppId: 'billing' })
		expect(body.target.payload.postgres).toBeUndefined()
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
			'https://control.example.test/api/namespaces/legacy-prod/adopt',
			'https://control.example.test/api/namespaces/legacy-prod/reconcile',
		])
		const adopted: { target: { payload: { managed: boolean; projectId: string } } } = JSON.parse(calls[0]?.body ?? '')
		expect(adopted.target.payload).toMatchObject({ managed: false, projectId: 'project-1' })
		expect(calls[1]?.body).toBeNull()
	})

	test('rejects missing coordinates and credentials before fetch', async () => {
		const calls: Call[] = []
		const args = parseZeropsCliArgs(['namespace', 'create', '--id=apps-prod', '--env=prod'])
		await expect(runZeropsNamespaceCommand(args, {
			source: {},
			fetch: recorder(calls),
			write: () => {},
		})).rejects.toThrow('--proxy-build-from-git or FABRIKA_ZEROPS_PROXY_BUILD_FROM_GIT is required')
		expect(calls).toEqual([])
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
