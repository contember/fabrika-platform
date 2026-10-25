import { OPS_ROW_COUNT_CAP, type OpsContentView, type OpsView } from '@fabrika/auth-core'
import type { DataBackupDto, DataOperationDto } from '@fabrika/control-contract'
import { afterEach, describe, expect, test } from 'bun:test'
import { runCli } from '..'
import { ENV_USAGE, runEnvCli } from '../data.js'

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
	runId: null,
}
const STUCK_ID = '0192c4a0-0000-7000-8000-0000000000aa'
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
		for (
			const form of [
				'env inspect <app> <env>',
				'env maintenance <app> <env>',
				'env operations <app> <env>',
				'env recover <app> <env>',
				'env backups <app> <env>',
				'env backups schedule <app> <env> [on|off]',
				'env restore <app> <env> --at=<time>',
			]
		) {
			expect(ENV_USAGE).toContain(form)
		}
	})

	test('the top-level usage lists the env area', async () => {
		const { out } = await captureOutput(() => runCli(['--help']))
		expect(out).toContain('fabrika env <inspect|maintenance|operations|recover|backups|restore>')
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
		await expect(runEnvCli('operations', ['notes', 'prod', `--at=${AT}`], CONTROL_ENV)).rejects.toThrow('--at applies to `env restore` only')
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

	test('refuses an operation that does not parse, and one of another environment', async () => {
		const refused: unknown[] = [
			{ ...OPERATION, state: 'paused' },
			{ ...OPERATION, id: `${OPERATION.id}\x1b]52;c;cGF5bG9hZA==\x07` },
			{ ...OPERATION, errorCode: 'Object Unreachable' },
			{ ...OPERATION, recoversOperationId: 'stuck-1' },
			{ ...OPERATION, appId: 'other' },
			{ ...OPERATION, env: 'staging' },
		]
		for (const result of refused) {
			fakeControl({ result })
			const { out } = await captureOutput(async () => {
				await expect(runEnvCli('maintenance', ['notes', 'prod', 'closed'], CONTROL_ENV)).rejects.toThrow(
					'Control returned an unreadable data operation',
				)
			})
			expect(out).toBe('')
		}
	})

	test('prints the known fields only: a field Control adds is dropped from --json', async () => {
		fakeControl({ result: { ...OPERATION, note: 'added by a newer Control' } })
		const { out } = await captureOutput(() => runEnvCli('maintenance', ['notes', 'prod', 'closed', '--json'], CONTROL_ENV))
		expect(JSON.parse(out)).toEqual(OPERATION)
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

	test('refuses a page holding an operation of another environment', async () => {
		fakeControl({ result: { items: [OPERATION, { ...OPERATION, env: 'staging' }], nextCursor: null } })
		await expect(runEnvCli('operations', ['notes', 'prod'], CONTROL_ENV)).rejects.toThrow('Control returned an unreadable list of data operations')
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
			const recovery = { ...OPERATION, kind: 'recovery', step: 'reconcile', targetMode: 'closed', recoversOperationId: STUCK_ID, resolution }
			const control = fakeControl({ result: recovery })
			const { out } = await captureOutput(() => runEnvCli('recover', ['notes', 'prod', STUCK_ID, resolution], CONTROL_ENV))
			expect(control.calls[0]?.body).toEqual({
				method: 'data.recover',
				input: { appId: 'notes', env: 'prod', operationId: STUCK_ID, resolution },
			})
			expect(out).toBe(`${OPERATION.id}\trecovery\trunning\treconcile\tclosed\t8\t-\t2025-10-24T12:00:00.000Z`)
		}
	})

	test('refuses a resolution other than resume or open before anything is sent', async () => {
		const control = fakeControl({ result: OPERATION })
		await expect(runEnvCli('recover', ['notes', 'prod', STUCK_ID, 'close'], CONTROL_ENV)).rejects.toThrow('The resolution is resume or open')
		expect(control.calls).toEqual([])
	})

	test('a 501 says the release does not offer it and that retrying will not help', async () => {
		fakeControl({ error: { type: 'internal', message: 'data operations are not available in this release' } }, 501)
		await expect(runEnvCli('recover', ['notes', 'prod', STUCK_ID, 'open'], CONTROL_ENV)).rejects.toThrow(
			'`env recover` is not available in this release of the control plane; retrying will not change that',
		)
	})
})

describe('env output safety', () => {
	test('refuses an origin that would expose the key, before anything is sent', async () => {
		const control = fakeControl({ result: VIEW })
		for (
			const origin of [
				'http://control.example',
				'https://operator:secret@control.example',
				'https://control.example/api',
				'https://control.example/?a=1',
			]
		) {
			await expect(runEnvCli('inspect', ['notes', 'prod', `--url=${origin}`], CONTROL_ENV)).rejects.toThrow('--url or FABRIKA_CONTROL_URL')
		}
		expect(control.calls).toEqual([])
	})

	test('a Control that echoes the key puts it on no output and into no error: human, --json, refusal', async () => {
		const echoed = { result: { ...CONTENT_VIEW, bootFailure: { at: AT, message: 'token px_test leaked', stack: null } } }
		const cases: [string, number, string[]][] = [
			[JSON.stringify(echoed), 200, ['--content']],
			// Behind a JSON escape, which a plain search of the body would miss.
			[JSON.stringify(echoed).replace('px_test', '\\u0070x_test'), 200, ['--content', '--json']],
			[JSON.stringify({ error: { type: 'not_found', message: 'no env for Bearer px_test' } }), 404, []],
		]
		for (const [body, status, flags] of cases) {
			globalThis.fetch = asFetch(async () => new Response(body, { status, headers: { 'content-type': 'application/json' } }))
			let message = ''
			const output = await captureOutput(async () => {
				message = await runEnvCli('inspect', ['notes', 'prod', ...flags], CONTROL_ENV).then(() => '', (error: unknown) => String(error))
			})
			expect(output).toEqual({ out: '', err: '' })
			expect(message).toBe("Error: transport: Control's answer carried [FABRIKA_CONTROL_KEY]; it was dropped")
		}
	})

	test('a diagnostic that would quote the key has it cut out', async () => {
		fakeControl({ result: VIEW })
		await expect(runEnvCli('inspect', ['notes', 'prod', '--px_test'], CONTROL_ENV)).rejects.toThrow('Unknown option: --[FABRIKA_CONTROL_KEY]')
	})

	test('diagnostics carry no control character', async () => {
		fakeControl({ error: { type: 'not_found', message: 'app env \x1b]52;c;cGF5bG9hZA==\x07not found' } }, 404)
		const refusal = await runEnvCli('inspect', ['notes', 'prod'], CONTROL_ENV).then(() => '', (error: unknown) => String(error))
		expect(refusal).toBe('Error: not_found: app env ]52;c;cGF5bG9hZA==not found')
		const usage = await runEnvCli('inspect', ['notes', 'prod', '--x\x1b[2J'], CONTROL_ENV).then(() => '', (error: unknown) => String(error))
		expect(usage).toBe('Error: Unknown option: --x[2J')
	})
})

const BACKUP: DataBackupDto = {
	id: '0192c4a0-0000-7000-8000-0000000000b1',
	appId: 'notes',
	env: 'prod',
	operationId: '0192c4a0-0000-7000-8000-0000000000b0',
	object: 'application',
	dumpId: '0192c4a0-0000-7000-8000-0000000000b2',
	preMigration: false,
	state: 'succeeded',
	errorCode: null,
	createdAt: 1_761_307_200,
	finishedAt: 1_761_307_260,
	bookmark: '0000000a-0000000b',
	sizeBytes: 52_428_800,
	parts: 7,
	tables: 12,
	rehearsal: 'passed',
	rehearsalCode: null,
	expired: false,
}
const BACKUP_LINE = `${BACKUP.id}\tapplication\tsucceeded\t2025-10-24T12:00:00.000Z\t52428800\t7\t12\tpassed\t-\t-\t-\tdaily`

describe('env backups', () => {
	test("lists the environment's backups, newest first, one row each with its rehearsal and expiry", async () => {
		const failed: DataBackupDto = {
			...BACKUP,
			id: '0192c4a0-0000-7000-8000-0000000000a1',
			preMigration: true,
			state: 'failed',
			errorCode: 'rehearsal_failed',
			sizeBytes: null,
			parts: null,
			tables: null,
			rehearsal: 'failed',
			rehearsalCode: 'hash_mismatch',
			expired: true,
		}
		const control = fakeControl({ result: { items: [BACKUP, failed], nextCursor: null } })
		const { out, err } = await captureOutput(() => runEnvCli('backups', ['notes', 'prod'], CONTROL_ENV))
		expect(control.calls[0]?.body).toEqual({ method: 'data.backups.list', input: { appId: 'notes', env: 'prod' } })
		expect(out).toBe([
			BACKUP_LINE,
			`${failed.id}\tapplication\tfailed\t2025-10-24T12:00:00.000Z\t-\t-\t-\tfailed\thash_mismatch\trehearsal_failed\texpired\tpre-migration`,
		].join('\n'))
		expect(err).toBe('')
	})

	test('an empty list says so on stderr; older backups beyond the page are disclosed; --json prints the parsed page', async () => {
		fakeControl({ result: { items: [], nextCursor: null } })
		expect(await captureOutput(() => runEnvCli('backups', ['notes', 'prod'], CONTROL_ENV))).toEqual({ out: '', err: 'notes prod has no backups' })
		fakeControl({ result: { items: [BACKUP], nextCursor: BACKUP.id } })
		expect((await captureOutput(() => runEnvCli('backups', ['notes', 'prod'], CONTROL_ENV))).err).toBe('showing the newest 1 backups; older ones exist')
		fakeControl({ result: { items: [{ ...BACKUP, note: 'added by a newer Control' }], nextCursor: null } })
		const { out } = await captureOutput(() => runEnvCli('backups', ['notes', 'prod', '--json'], CONTROL_ENV))
		expect(JSON.parse(out)).toEqual({ items: [BACKUP], nextCursor: null })
	})

	test('refuses a page that does not parse, or that holds a backup of another environment', async () => {
		for (
			const item of [
				{ ...BACKUP, rehearsal: 'skipped' },
				{ ...BACKUP, errorCode: 'Error: tenant 7' },
				{ ...BACKUP, object: 'Application\x1b[2J' },
				{ ...BACKUP, sizeBytes: -1 },
				{ ...BACKUP, env: 'staging' },
			]
		) {
			fakeControl({ result: { items: [item], nextCursor: null } })
			await expect(runEnvCli('backups', ['notes', 'prod'], CONTROL_ENV)).rejects.toThrow('Control returned an unreadable list of backups')
		}
	})

	test('a refusal prints its code', async () => {
		fakeControl({ error: { type: 'not_found', message: 'app env not found' } }, 404)
		await expect(runEnvCli('backups', ['notes', 'prod'], CONTROL_ENV)).rejects.toThrow('not_found: app env not found')
	})
})

describe('env backups schedule', () => {
	const SCHEDULE = { appId: 'notes', env: 'prod', daily: true, updatedAt: null }

	test('reads the schedule without a switch', async () => {
		const control = fakeControl({ result: SCHEDULE })
		const { out, err } = await captureOutput(() => runEnvCli('backups', ['schedule', 'notes', 'prod'], CONTROL_ENV))
		expect(control.calls[0]?.body).toEqual({ method: 'data.backups.schedule', input: { appId: 'notes', env: 'prod' } })
		expect(out).toBe('daily\ton\nupdatedAt\t-')
		expect(err).toBe('')
	})

	test('on and off set it, and off says the backup before a migration still runs', async () => {
		const control = fakeControl({ result: { ...SCHEDULE, daily: false, updatedAt: 1_761_307_200 } })
		const off = await captureOutput(() => runEnvCli('backups', ['schedule', 'notes', 'prod', 'off'], CONTROL_ENV))
		expect(control.calls[0]?.body).toEqual({ method: 'data.backups.setSchedule', input: { appId: 'notes', env: 'prod', daily: false } })
		expect(off).toEqual({ out: 'daily\toff\nupdatedAt\t2025-10-24T12:00:00.000Z', err: 'the backup before a migration still runs' })

		const on = fakeControl({ result: { ...SCHEDULE, updatedAt: 1_761_307_200 } })
		const json = await captureOutput(() => runEnvCli('backups', ['schedule', 'notes', 'prod', 'on', '--json'], CONTROL_ENV))
		expect(on.calls[0]?.body).toEqual({ method: 'data.backups.setSchedule', input: { appId: 'notes', env: 'prod', daily: true } })
		expect(JSON.parse(json.out)).toEqual({ ...SCHEDULE, updatedAt: 1_761_307_200 })
	})

	test('refuses a switch other than on or off before anything is sent, and an answer of another environment', async () => {
		const control = fakeControl({ result: SCHEDULE })
		await expect(runEnvCli('backups', ['schedule', 'notes', 'prod', 'yes'], CONTROL_ENV)).rejects.toThrow('The schedule is on or off, not "yes"')
		await expect(runEnvCli('backups', ['schedule', 'notes', 'prod', 'on', 'extra'], CONTROL_ENV)).rejects.toThrow(
			'Usage: fabrika env backups schedule <app> <env> [on|off]',
		)
		expect(control.calls).toEqual([])
		fakeControl({ result: { ...SCHEDULE, env: 'staging' } })
		await expect(runEnvCli('backups', ['schedule', 'notes', 'prod'], CONTROL_ENV)).rejects.toThrow('Control returned an unreadable backup schedule')
	})

	test('a caller without data.manage gets the refusal as its code', async () => {
		fakeControl({ error: { type: 'not_found', message: 'app env not found' } }, 404)
		await expect(runEnvCli('backups', ['schedule', 'notes', 'prod', 'off'], CONTROL_ENV)).rejects.toThrow('not_found: app env not found')
	})
})

describe('env restore', () => {
	const RESTORE: DataOperationDto = { ...OPERATION, kind: 'restore', step: 'list', targetMode: 'open' }

	test('starts a side restore at the time given and prints it, pointing at the operations list while it runs', async () => {
		for (const flags of [[`--at=${AT}`], ['--at', AT]]) {
			const control = fakeControl({ result: RESTORE })
			const { out, err } = await captureOutput(() => runEnvCli('restore', ['notes', 'prod', ...flags], CONTROL_ENV))
			expect(control.calls[0]?.body).toEqual({ method: 'data.start', input: { appId: 'notes', env: 'prod', kind: 'restore', at: AT } })
			expect(out).toBe(`${OPERATION.id}\trestore\trunning\tlist\topen\t8\t-\t2025-10-24T12:00:00.000Z`)
			expect(err).toBe('follow it: fabrika env operations notes prod')
		}
	})

	test('every step of a restore reads back through operations', async () => {
		const steps = ['list', 'restrict', 'backup', 'verify', 'import', 'promote', 'point', 'serve', 'rewind', 'check', 'revert', 'open'] as const
		fakeControl({ result: { items: steps.map((step) => ({ ...RESTORE, step })), nextCursor: null } })
		const { out } = await captureOutput(() => runEnvCli('operations', ['notes', 'prod'], CONTROL_ENV))
		expect(out.split('\n').map((line) => line.split('\t')[3])).toEqual([...steps])
	})

	test('refuses a missing or unreadable time before anything is sent', async () => {
		const control = fakeControl({ result: RESTORE })
		await expect(runEnvCli('restore', ['notes', 'prod'], CONTROL_ENV)).rejects.toThrow('Usage: fabrika env restore <app> <env> --at=<time>')
		await expect(runEnvCli('restore', ['notes', 'prod', '--at'], CONTROL_ENV)).rejects.toThrow('Usage: fabrika env restore <app> <env> --at=<time>')
		for (const at of ['yesterday', '2026-10-24', '2026-10-24T12:00:00']) {
			await expect(runEnvCli('restore', ['notes', 'prod', `--at=${at}`], CONTROL_ENV)).rejects.toThrow(
				`The time is ISO 8601 with an offset, such as ${AT}, not "${at}"`,
			)
		}
		expect(control.calls).toEqual([])
	})

	test("Control's refusal of a time not in the past, or of a full object list, prints as its code", async () => {
		fakeControl({ error: { type: 'bad_request', message: 'the restore time must lie in the past' } }, 400)
		await expect(runEnvCli('restore', ['notes', 'prod', `--at=${AT}`], CONTROL_ENV)).rejects.toThrow(
			'bad_request: the restore time must lie in the past',
		)
		fakeControl({ error: { type: 'conflict', message: "the environment's object list is full (16 names): no clone can be listed" } }, 409)
		await expect(runEnvCli('restore', ['notes', 'prod', `--at=${AT}`], CONTROL_ENV)).rejects.toThrow('conflict: ')
	})

	test('a failed restore is an answer: it prints with its code and names the recovery on stderr', async () => {
		fakeControl({ result: { ...RESTORE, step: 'open', state: 'failed', errorCode: 'import_failed', finishedAt: 1_761_307_260 } })
		const { out, err } = await captureOutput(() => runEnvCli('restore', ['notes', 'prod', `--at=${AT}`], CONTROL_ENV))
		expect(out).toBe(`${OPERATION.id}\trestore\tfailed\topen\topen\t8\timport_failed\t2025-10-24T12:00:00.000Z`)
		expect(err).toBe(`open the environment past it: fabrika env recover notes prod ${OPERATION.id} open`)
	})
})
