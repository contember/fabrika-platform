import { OPS_ROW_COUNT_CAP, type OpsContentView, type OpsView } from '@fabrika/auth-core'
import type { DataOperationDto } from '@fabrika/control-contract'
import { afterEach, describe, expect, test } from 'bun:test'
import { runCli } from '..'
import { ENV_USAGE, runEnvCli } from '../env.js'

const CONTROL_ENV = { FABRIKA_CONTROL_URL: 'https://control.example', FABRIKA_CONTROL_KEY: 'px_test' } as const

const AT = '2026-10-24T12:00:00.000Z'
const VIEW: OpsView = {
	release: '0.9.0',
	maintenance: { mode: 'read-only', generation: 7, published: true },
	database: { sizeBytes: 4096, tables: [{ name: 'notes', rows: 12 }, { name: 'events', rows: OPS_ROW_COUNT_CAP }] },
	migrations: [{ bundle: 'fabrika', name: '0001_framework.sql', checksum: 'a'.repeat(64), appliedAt: AT }],
	scheduler: { alarm: null },
	jobs: [{ job: 'nightlyDigest', lastStatus: 'failed', lastStartedAt: AT, lastFinishedAt: AT, lastDurationMs: 120 }],
	files: [{ kind: 'avatar', status: 'live', count: 3 }],
	webhooks: [{ webhook: 'github', state: 'claimed', count: 1 }],
	bootFailure: { at: AT },
}
const CONTENT_VIEW: OpsContentView = { ...VIEW, bootFailure: { at: AT, message: 'boot failed\x1b[2J', stack: 'Error: boot failed\n    at boot' } }

const OPERATION: DataOperationDto = {
	id: '0192c4a0-0000-7000-8000-000000000001',
	appId: 'notes',
	env: 'prod',
	kind: 'maintenance',
	step: 'restrict',
	targetMode: 'read-only',
	generation: 8,
	state: 'running',
	errorCode: null,
	actor: 'principal-1',
	createdAt: 1_761_307_200,
	updatedAt: 1_761_307_200,
	finishedAt: null,
	recoversOperationId: null,
	resolution: null,
}
const OPERATION_LINE = `${OPERATION.id}\tmaintenance\trunning\trestrict\tread-only\t8\t-\t2025-10-24T12:00:00.000Z`

interface Captured {
	readonly url: string
	readonly authorization: string | null
	readonly redirect: RequestRedirect | undefined
	readonly body: unknown
}

const realFetch = globalThis.fetch

/** Bun's `fetch` carries `preconnect`, so a stub must too — and borrowing the real one beats a cast. */
const asFetch = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch =>
	Object.assign(handler, { preconnect: realFetch.preconnect })

/** A fake Control: answers every request with one envelope and status, and records what the client sent. */
const fakeControl = (envelope: unknown, status = 200): { calls: Captured[] } => {
	const calls: Captured[] = []
	globalThis.fetch = asFetch(async (input, init) => {
		const raw = init?.body
		calls.push({
			url: String(input),
			authorization: new Headers(init?.headers).get('authorization'),
			redirect: init?.redirect,
			body: typeof raw === 'string' ? JSON.parse(raw) : null,
		})
		return new Response(JSON.stringify(envelope), { status, headers: { 'content-type': 'application/json' } })
	})
	return { calls }
}

/** Run `run` and collect what it printed to stdout (`console.info`) and to stderr (`console.warn`). */
const captureOutput = async (run: () => Promise<void>): Promise<{ out: string; err: string }> => {
	const out: string[] = []
	const err: string[] = []
	const info = console.info
	const warn = console.warn
	console.info = (...args: unknown[]) => void out.push(args.map((arg) => String(arg)).join(' '))
	console.warn = (...args: unknown[]) => void err.push(args.map((arg) => String(arg)).join(' '))
	try {
		await run()
	} finally {
		console.info = info
		console.warn = warn
	}
	return { out: out.join('\n'), err: err.join('\n') }
}

afterEach(() => {
	globalThis.fetch = realFetch
})

describe('env routing and help', () => {
	test('`fabrika env --help` and a bare `fabrika env` print the usage, which names every command', async () => {
		const help = await captureOutput(() => runCli(['env', '--help']))
		const bare = await captureOutput(() => runEnvCli(undefined, [], CONTROL_ENV))
		expect(help.out).toBe(ENV_USAGE)
		expect(bare.out).toBe(ENV_USAGE)
		for (const form of ['env inspect <app> <env>', 'env maintenance <app> <env>', 'env operations <app> <env>', 'env recover <app> <env>']) {
			expect(ENV_USAGE).toContain(form)
		}
	})

	test('the top-level usage lists the env area', async () => {
		const { out } = await captureOutput(() => runCli(['--help']))
		expect(out).toContain('fabrika env <inspect|maintenance|operations|recover>')
	})

	test('routes `fabrika env <command>` to the area, with the key from the process environment', async () => {
		const control = fakeControl({ result: VIEW })
		const previous = process.env['FABRIKA_CONTROL_KEY']
		process.env['FABRIKA_CONTROL_KEY'] = 'px_routed'
		try {
			await captureOutput(() => runCli(['env', 'inspect', 'notes', 'prod', '--url=https://elsewhere.example']))
		} finally {
			if (previous === undefined) delete process.env['FABRIKA_CONTROL_KEY']
			else process.env['FABRIKA_CONTROL_KEY'] = previous
		}
		expect(control.calls[0]).toMatchObject({ url: 'https://elsewhere.example/api/rpc', authorization: 'Bearer px_routed' })
	})

	test('refuses an unknown command, a wrong number of arguments, an unknown option and a misplaced --content', async () => {
		fakeControl({ result: VIEW })
		await expect(runEnvCli('backup', ['notes', 'prod'], CONTROL_ENV)).rejects.toThrow('Unknown env command: backup')
		await expect(runEnvCli('inspect', ['notes'], CONTROL_ENV)).rejects.toThrow('Usage: fabrika env inspect <app> <env>')
		await expect(runEnvCli('inspect', ['notes', 'prod', 'extra'], CONTROL_ENV)).rejects.toThrow('Usage: fabrika env inspect <app> <env>')
		await expect(runEnvCli('inspect', ['notes', 'prod', '--app=notes'], CONTROL_ENV)).rejects.toThrow('Unknown option: --app=notes')
		await expect(runEnvCli('operations', ['notes', 'prod', '--content'], CONTROL_ENV)).rejects.toThrow('--content applies to `env inspect` only')
	})
})

describe('env credentials', () => {
	test('requires the control key from the environment and an origin from --url or the environment', async () => {
		await expect(runEnvCli('inspect', ['notes', 'prod'], { FABRIKA_CONTROL_URL: 'https://control.example' }))
			.rejects.toThrow('FABRIKA_CONTROL_KEY is required')
		await expect(runEnvCli('inspect', ['notes', 'prod'], { FABRIKA_CONTROL_KEY: 'px_test' }))
			.rejects.toThrow('Pass --url=<origin> or set FABRIKA_CONTROL_URL')
	})

	test("sends the key as a bearer to Control's RPC path and follows no redirect", async () => {
		const control = fakeControl({ result: VIEW })
		await captureOutput(() => runEnvCli('inspect', ['notes', 'prod'], { ...CONTROL_ENV, FABRIKA_CONTROL_URL: 'https://control.example/' }))
		expect(control.calls).toHaveLength(1)
		expect(control.calls[0]).toMatchObject({ url: 'https://control.example/api/rpc', authorization: 'Bearer px_test', redirect: 'manual' })
	})
})

describe('env inspect', () => {
	test('calls data.view and prints one keyed row per fact of the view', async () => {
		const control = fakeControl({ result: VIEW })
		const { out, err } = await captureOutput(() => runEnvCli('inspect', ['notes', 'prod'], CONTROL_ENV))
		expect(control.calls[0]?.body).toEqual({ method: 'data.view', input: { appId: 'notes', env: 'prod' } })
		expect(out).toBe([
			'release\t0.9.0',
			'mode\tread-only',
			'generation\t7',
			'published\tyes',
			'databaseBytes\t4096',
			'table\tnotes\t12',
			`table\tevents\t${OPS_ROW_COUNT_CAP}+`,
			`migration\tfabrika\t0001_framework.sql\t${AT}`,
			'alarm\t-',
			`job\tnightlyDigest\tfailed\t${AT}\t${AT}\t120`,
			'file\tavatar\tlive\t3',
			'webhook\tgithub\tclaimed\t1',
			`bootFailure\t${AT}`,
		].join('\n'))
		expect(err).toBe('')
	})

	test('an object that never published a transition shows its generation as -', async () => {
		fakeControl({ result: { ...VIEW, maintenance: { mode: 'open', generation: null, published: false }, bootFailure: null } })
		const { out } = await captureOutput(() => runEnvCli('inspect', ['notes', 'prod'], CONTROL_ENV))
		expect(out).toContain('mode\topen\ngeneration\t-\npublished\tno')
		expect(out).toContain('bootFailure\t-')
	})

	test('--json prints the view as JSON', async () => {
		fakeControl({ result: VIEW })
		const { out } = await captureOutput(() => runEnvCli('inspect', ['notes', 'prod', '--json'], CONTROL_ENV))
		expect(JSON.parse(out)).toEqual(VIEW)
	})

	test('--content calls data.content and prints the boot failure message, with terminal control characters cut out', async () => {
		const control = fakeControl({ result: CONTENT_VIEW })
		const { out } = await captureOutput(() => runEnvCli('inspect', ['notes', 'prod', '--content'], CONTROL_ENV))
		expect(control.calls[0]?.body).toEqual({ method: 'data.content', input: { appId: 'notes', env: 'prod' } })
		expect(out.endsWith(`bootFailure\t${AT}\n\nboot failed[2J\nError: boot failed\n    at boot`)).toBe(true)

		fakeControl({ result: CONTENT_VIEW })
		const json = await captureOutput(() => runEnvCli('inspect', ['notes', 'prod', '--content', '--json'], CONTROL_ENV))
		expect(JSON.parse(json.out)).toEqual(CONTENT_VIEW)
	})

	test('refuses a view that does not parse, and a content field in the metadata view', async () => {
		fakeControl({ result: { ...VIEW, release: 'latest' } })
		await expect(runEnvCli('inspect', ['notes', 'prod'], CONTROL_ENV)).rejects.toThrow('Control returned an unreadable data view')
		fakeControl({ result: CONTENT_VIEW })
		await expect(runEnvCli('inspect', ['notes', 'prod'], CONTROL_ENV)).rejects.toThrow('Control returned an unreadable data view')
	})

	test('a refusal keeps its type, so "not found or not allowed" reads apart from an outage', async () => {
		fakeControl({ error: { type: 'not_found', message: 'app env not found' } }, 404)
		await expect(runEnvCli('inspect', ['notes', 'prod', '--content'], CONTROL_ENV)).rejects.toThrow('not_found: app env not found')
	})
})

describe('env maintenance', () => {
	test('starts a maintenance operation in the mode given and prints it, pointing at the operations list while it runs', async () => {
		for (const mode of ['open', 'read-only', 'closed'] as const) {
			const control = fakeControl({ result: { ...OPERATION, targetMode: mode } })
			const { out, err } = await captureOutput(() => runEnvCli('maintenance', ['notes', 'prod', mode], CONTROL_ENV))
			expect(control.calls[0]?.body).toEqual({ method: 'data.start', input: { appId: 'notes', env: 'prod', kind: 'maintenance', mode } })
			expect(out).toBe(OPERATION_LINE.replace('read-only', mode))
			expect(err).toBe('follow it: fabrika env operations notes prod')
		}
	})

	test('refuses a mode an operator cannot request before anything is sent', async () => {
		const control = fakeControl({ result: OPERATION })
		await expect(runEnvCli('maintenance', ['notes', 'prod', 'inspect'], CONTROL_ENV)).rejects.toThrow(
			'The mode is one of open, read-only, closed',
		)
		expect(control.calls).toEqual([])
	})

	test('a failed operation is an answer: it prints and names the recovery on stderr', async () => {
		fakeControl({ result: { ...OPERATION, state: 'failed', errorCode: 'object_unreachable', finishedAt: 1_761_307_260 } })
		const { out, err } = await captureOutput(() => runEnvCli('maintenance', ['notes', 'prod', 'read-only'], CONTROL_ENV))
		expect(out).toBe(OPERATION_LINE.replace('running', 'failed').replace('\t-\t', '\tobject_unreachable\t'))
		expect(err).toBe(`open the environment past it: fabrika env recover notes prod ${OPERATION.id} open`)
	})

	test('--json prints the operation as JSON', async () => {
		fakeControl({ result: OPERATION })
		const { out } = await captureOutput(() => runEnvCli('maintenance', ['notes', 'prod', 'closed', '--json'], CONTROL_ENV))
		expect(JSON.parse(out)).toEqual(OPERATION)
	})

	test('a 501 says the release does not offer it and that retrying will not help', async () => {
		fakeControl({ error: { type: 'internal', message: 'data operations are not available in this release' } }, 501)
		await expect(runEnvCli('maintenance', ['notes', 'prod', 'read-only'], CONTROL_ENV)).rejects.toThrow(
			'`env maintenance` is not available in this release of the control plane; retrying will not change that',
		)
	})

	test('refuses an operation that does not parse', async () => {
		fakeControl({ result: { ...OPERATION, state: 'paused' } })
		await expect(runEnvCli('maintenance', ['notes', 'prod', 'closed'], CONTROL_ENV)).rejects.toThrow('Control returned an unreadable data operation')
	})
})

describe('env operations', () => {
	test("lists the environment's operations, newest first, one row each", async () => {
		const older = { ...OPERATION, id: '0192c4a0-0000-7000-8000-000000000000', state: 'succeeded', step: 'open' }
		const control = fakeControl({ result: { items: [OPERATION, older], nextCursor: null } })
		const { out, err } = await captureOutput(() => runEnvCli('operations', ['notes', 'prod'], CONTROL_ENV))
		expect(control.calls[0]?.body).toEqual({ method: 'data.operations.list', input: { appId: 'notes', env: 'prod' } })
		expect(out).toBe([OPERATION_LINE, `${older.id}\tmaintenance\tsucceeded\topen\tread-only\t8\t-\t2025-10-24T12:00:00.000Z`].join('\n'))
		expect(err).toBe('')
	})

	test('an empty list prints no row and says so on stderr; --json still prints the result', async () => {
		fakeControl({ result: { items: [], nextCursor: null } })
		expect(await captureOutput(() => runEnvCli('operations', ['notes', 'prod'], CONTROL_ENV))).toEqual({
			out: '',
			err: 'notes prod has no data operations',
		})
		fakeControl({ result: { items: [], nextCursor: null } })
		const { out } = await captureOutput(() => runEnvCli('operations', ['notes', 'prod', '--json'], CONTROL_ENV))
		expect(JSON.parse(out)).toEqual({ items: [], nextCursor: null })
	})

	test('says on stderr when older operations exist beyond the page', async () => {
		fakeControl({ result: { items: [OPERATION], nextCursor: OPERATION.id } })
		const { err } = await captureOutput(() => runEnvCli('operations', ['notes', 'prod'], CONTROL_ENV))
		expect(err).toBe('showing the newest 1 operations; older ones exist')
	})
})

describe('env recover', () => {
	test('recovers a stuck operation with the resolution given and prints the recovery', async () => {
		for (const resolution of ['resume', 'open'] as const) {
			const recovery = { ...OPERATION, kind: 'recovery', step: 'reconcile', targetMode: 'closed', recoversOperationId: 'stuck-1', resolution }
			const control = fakeControl({ result: recovery })
			const { out } = await captureOutput(() => runEnvCli('recover', ['notes', 'prod', 'stuck-1', resolution], CONTROL_ENV))
			expect(control.calls[0]?.body).toEqual({
				method: 'data.recover',
				input: { appId: 'notes', env: 'prod', operationId: 'stuck-1', resolution },
			})
			expect(out).toBe(`${OPERATION.id}\trecovery\trunning\treconcile\tclosed\t8\t-\t2025-10-24T12:00:00.000Z`)
		}
	})

	test('refuses a resolution other than resume or open before anything is sent', async () => {
		const control = fakeControl({ result: OPERATION })
		await expect(runEnvCli('recover', ['notes', 'prod', 'stuck-1', 'close'], CONTROL_ENV)).rejects.toThrow('The resolution is resume or open')
		expect(control.calls).toEqual([])
	})

	test('a 501 says the release does not offer it and that retrying will not help', async () => {
		fakeControl({ error: { type: 'internal', message: 'data operations are not available in this release' } }, 501)
		await expect(runEnvCli('recover', ['notes', 'prod', 'stuck-1', 'open'], CONTROL_ENV)).rejects.toThrow(
			'`env recover` is not available in this release of the control plane; retrying will not change that',
		)
	})
})
