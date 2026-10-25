import { describe, expect, test } from 'bun:test'
import { isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
	type ConsoleAccessDto,
	type ControlFetch,
	createControlClient,
	type CursorList,
	type DataBackupDto,
	type DataBackupScheduleDto,
	type DataOperationDto,
} from '../lib/api'
import type { ConsoleCaller } from '../lib/console-access'
import { ConsoleAccessContext } from '../lib/console-caller'
import { fmtDate } from '../lib/format'
import { workspaceGate } from '../routes/_layout'
import {
	ActionOutcome,
	BackupsSection,
	BootFailureMessage,
	BootFailureText,
	type DataAction,
	DataPage,
	type DataRead,
	DataSections,
	DataView,
	type DataViewDto,
	loadDataView,
	OperationProgress,
	parseRestoreTime,
	readBootFailure,
	RecoverControl,
	recoverOperation,
	recoveryChoice,
	RecoveryEffect,
	RestoreEffect,
	RestoreOccurrences,
	scheduleOperationPoll,
	setBackupSchedule,
	startMaintenance,
	startRestore,
	StateSection,
} from '../routes/apps/data'

const view = (overrides: Partial<DataViewDto> = {}): DataViewDto => ({
	release: '0.9.0',
	maintenance: { mode: 'read-only', generation: 7, published: true },
	database: { sizeBytes: 3_145_728, tables: [{ name: 'notes', rows: 1204 }, { name: 'tags', rows: 0 }] },
	migrations: [],
	scheduler: { alarm: null },
	jobs: [{
		job: 'digest',
		lastStatus: 'failed',
		lastStartedAt: '2026-10-24T08:00:00.000Z',
		lastFinishedAt: '2026-10-24T08:00:02.500Z',
		lastDurationMs: 2500,
	}],
	files: [{ kind: 'attachment', status: 'quarantined', count: 3 }],
	webhooks: [{ webhook: 'stripe', state: 'claimed', count: 2 }],
	bootFailure: { at: '2026-10-24T09:30:00.000Z' },
	...overrides,
})

const operation = (id: string, overrides: Partial<DataOperationDto> = {}): DataOperationDto => ({
	id,
	appId: 'notes',
	env: 'prod',
	kind: 'maintenance',
	step: 'restrict',
	targetMode: 'read-only',
	generation: 7,
	state: 'running',
	errorCode: null,
	actor: 'principal-1',
	createdAt: 1_790_000_000,
	updatedAt: 1_790_000_010,
	finishedAt: null,
	recoversOperationId: null,
	resolution: null,
	...overrides,
})

const page = (items: DataOperationDto[], nextCursor: string | null = null): DataRead<CursorList<DataOperationDto>> => ({
	kind: 'ok',
	value: { items, nextCursor },
})

const backup = (id: string, overrides: Partial<DataBackupDto> = {}): DataBackupDto => ({
	id,
	appId: 'notes',
	env: 'prod',
	operationId: `op-of-${id}`,
	object: 'application',
	state: 'succeeded',
	errorCode: null,
	createdAt: 1_790_000_000,
	finishedAt: 1_790_000_060,
	bookmark: '0000000a-0000000b',
	sizeBytes: 52_428_800,
	parts: 7,
	tables: 12,
	rehearsal: 'passed',
	rehearsalCode: null,
	expired: false,
	...overrides,
})

const backupPage = (items: DataBackupDto[], nextCursor: string | null = null): DataRead<CursorList<DataBackupDto>> => ({
	kind: 'ok',
	value: { items, nextCursor },
})

const schedule = (daily = true): DataRead<DataBackupScheduleDto> => ({ kind: 'ok', value: { appId: 'notes', env: 'prod', daily, updatedAt: null } })

const holding = (global: string[], scope?: { type: 'app' | 'environment'; value: string; actions: string[] }): ConsoleAccessDto => ({
	principal: null,
	global,
	scopes: scope === undefined ? [] : [scope],
})

const markup = (
	access: ConsoleAccessDto | null,
	read: DataRead<DataViewDto> = { kind: 'ok', value: view() },
	operations: DataRead<CursorList<DataOperationDto>> = page([operation('op-2')]),
	backups: DataRead<CursorList<DataBackupDto>> = backupPage([backup('bk-1')]),
	daily: DataRead<DataBackupScheduleDto> = schedule(),
): string =>
	renderToStaticMarkup(
		<ConsoleAccessContext.Provider value={access}>
			<DataView appId="notes" env="prod" view={read} operations={operations} backups={backups} schedule={daily} onChanged={() => undefined} />
		</ConsoleAccessContext.Provider>,
	)

type Call = { method: string; input: unknown }

/** A fake Control that answers each procedure from `answers`, and records what it was asked. */
function fakeControl(calls: Call[], answers: Record<string, () => Response>): ControlFetch {
	return async (_input, init) => {
		if (typeof init?.body !== 'string') throw new Error('expected JSON RPC body')
		const body: unknown = JSON.parse(init.body)
		if (body === null || typeof body !== 'object' || !('method' in body) || typeof body.method !== 'string' || !('input' in body)) {
			throw new Error('expected RPC envelope')
		}
		calls.push({ method: body.method, input: body.input })
		const answer = answers[body.method]
		if (answer === undefined) throw new Error(`unexpected call ${body.method}`)
		return answer()
	}
}

const refusal = (status: number, message = 'refused') => () => Response.json({ error: { type: 'error', message } }, { status })
const result = (value: unknown) => () => Response.json({ result: value })

const MANAGE_ONLY_TEXT = ['Start maintenance', 'Recover', 'Turn off daily backups', 'Restore to this time']

describe('the data view shows what the environment reports', () => {
	test('mode, generation, size, table counts, jobs, files, webhooks and the boot failure time', () => {
		const html = markup(holding(['data.read']))
		expect(html).toContain('read-only')
		expect(html).toContain('Generation')
		expect(html).toContain('>7<')
		expect(html).toContain('3.0 MiB')
		expect(html).toContain('<code>notes</code>')
		expect(html).toContain((1204).toLocaleString())
		expect(html).toContain('<code>digest</code>')
		expect(html).toContain('failed')
		expect(html).toContain('<code>attachment</code>')
		expect(html).toContain('quarantined')
		expect(html).toContain('<code>stripe</code>')
		expect(html).toContain('claimed')
		expect(html).toContain(fmtDate(Date.parse('2026-10-24T09:30:00.000Z') / 1000))
		expect(html).toContain('Boot failure')
	})

	test('an object that never transitioned reads as open with no generation, and a pending publication says so', () => {
		expect(markup(holding(['data.read']), { kind: 'ok', value: view({ maintenance: { mode: 'open', generation: null, published: true } }) })).toContain(
			'none yet',
		)
		expect(markup(holding(['data.read']), { kind: 'ok', value: view({ maintenance: { mode: 'closed', generation: 8, published: false } }) })).toContain(
			'not yet published',
		)
	})

	test('the operations list shows each operation, and discloses that it is only the newest page', () => {
		const html = markup(
			holding(['data.read']),
			undefined,
			page([operation('op-2'), operation('op-1', { state: 'succeeded', finishedAt: 1_790_000_020 })], 'op-1'),
		)
		expect(html).toContain('<code>op-2</code>')
		expect(html).toContain('<code>op-1</code>')
		expect(html).toContain('succeeded')
		expect(html).toContain('restrict')
		expect(html).toContain('The newest 2 operations')
	})

	test('no boot failure reads as none', () => {
		expect(markup(holding(['data.read']), { kind: 'ok', value: view({ bootFailure: null }) })).toContain('No boot failure recorded')
	})
})

describe('a refusal is a plain not-allowed state, never an error', () => {
	test('a refused view renders not allowed and no controls', () => {
		const html = markup(
			holding(['data.manage', 'data.content.read']),
			{ kind: 'not-allowed' },
			{ kind: 'not-allowed' },
			{ kind: 'not-allowed' },
			{ kind: 'not-allowed' },
		)
		expect(html).toContain('not allowed')
		expect(html).not.toContain('role="alert"')
		for (const text of [...MANAGE_ONLY_TEXT, 'Show the error message']) expect(html).not.toContain(text)
	})

	test('an environment without an ops channel says to redeploy', () => {
		expect(markup(holding(['data.read']), { kind: 'no-channel' })).toContain('Redeploy')
	})

	test('the loader reads the view, the operations, the backups and their schedule, and maps 404 and 403 to not-allowed, 409 to no channel', async () => {
		const calls: Call[] = []
		const ok = await loadDataView(
			createControlClient(
				fakeControl(calls, {
					'data.view': result(view()),
					'data.operations.list': result({ items: [], nextCursor: null }),
					'data.backups.list': result({ items: [backup('bk-1')], nextCursor: null }),
					'data.backups.schedule': result({ appId: 'notes', env: 'prod', daily: true, updatedAt: null }),
				}),
			),
			'notes',
			'prod',
		)
		expect(ok.view).toEqual({ kind: 'ok', value: view() })
		expect(ok.operations).toEqual({ kind: 'ok', value: { items: [], nextCursor: null } })
		expect(ok.backups).toEqual(backupPage([backup('bk-1')]))
		expect(ok.schedule).toEqual(schedule())
		expect(calls).toEqual([
			{ method: 'data.view', input: { appId: 'notes', env: 'prod' } },
			{ method: 'data.operations.list', input: { appId: 'notes', env: 'prod', limit: 25 } },
			{ method: 'data.backups.list', input: { appId: 'notes', env: 'prod', limit: 25 } },
			{ method: 'data.backups.schedule', input: { appId: 'notes', env: 'prod' } },
		])

		const hidden = await loadDataView(
			createControlClient(
				fakeControl([], {
					'data.view': refusal(404),
					'data.operations.list': refusal(403),
					'data.backups.list': refusal(404),
					'data.backups.schedule': refusal(404),
				}),
			),
			'notes',
			'prod',
		)
		expect(hidden).toEqual({
			view: { kind: 'not-allowed' },
			operations: { kind: 'not-allowed' },
			backups: { kind: 'not-allowed' },
			schedule: { kind: 'not-allowed' },
		})

		const unreached = await loadDataView(
			createControlClient(
				fakeControl([], {
					'data.view': refusal(409),
					'data.operations.list': refusal(502),
					'data.backups.list': refusal(503),
					'data.backups.schedule': refusal(503),
				}),
			),
			'notes',
			'prod',
		)
		expect(unreached).toEqual({
			view: { kind: 'no-channel' },
			operations: { kind: 'unavailable' },
			backups: { kind: 'unavailable' },
			schedule: { kind: 'unavailable' },
		})
	})
})

describe('controls follow consoleAccess', () => {
	test('maintenance and recovery show only to a caller holding data.manage at the environment', () => {
		for (const access of [null, holding(['data.manage']), holding([], { type: 'app', value: 'notes', actions: ['data.manage'] })]) {
			const html = markup(access)
			for (const text of MANAGE_ONLY_TEXT) expect(html).toContain(text)
		}
		for (
			const access of [
				holding(['data.read']),
				holding([], { type: 'environment', value: 'stage', actions: ['data.manage'] }),
				holding([], { type: 'app', value: 'blog', actions: ['data.manage'] }),
			]
		) {
			const html = markup(access)
			for (const text of MANAGE_ONLY_TEXT) expect(html).not.toContain(text)
		}
	})

	test('the maintenance control offers read-only, closed and open', () => {
		const html = markup(holding(['data.manage']))
		expect(html).toContain('value="read-only"')
		expect(html).toContain('value="closed"')
		expect(html).toContain('value="open"')
		expect(html).not.toContain('value="inspect"')
	})

	test('the content view shows only to a global data.content.read holder, and only when a boot failed', () => {
		expect(markup(holding(['data.read', 'data.content.read']))).toContain('Show the error message')
		expect(markup(null)).not.toContain('Show the error message')
		expect(markup(holding(['data.read']))).not.toContain('Show the error message')
		expect(markup(holding(['data.read'], { type: 'app', value: 'notes', actions: ['data.content.read'] }))).not.toContain('Show the error message')
		expect(markup(holding(['data.content.read']), { kind: 'ok', value: view({ bootFailure: null }) })).not.toContain('Show the error message')
	})
})

describe('recovery', () => {
	test('a running newest operation can resume or open; a failed one can only open; a finished one offers nothing', () => {
		expect(recoveryChoice([operation('op-2'), operation('op-1', { state: 'succeeded' })])).toEqual({
			operation: operation('op-2'),
			resolutions: ['resume', 'open'],
		})
		expect(recoveryChoice([operation('op-2', { state: 'failed', errorCode: 'stale_generation' })])).toEqual({
			operation: operation('op-2', { state: 'failed', errorCode: 'stale_generation' }),
			resolutions: ['open'],
		})
		expect(recoveryChoice([operation('op-2', { state: 'succeeded' }), operation('op-1')])).toBeNull()
		expect(recoveryChoice([])).toBeNull()
	})

	test('no recover control when nothing is stuck', () => {
		expect(markup(holding(['data.manage']), undefined, page([operation('op-2', { state: 'succeeded' })]))).not.toContain('Recover')
	})

	test('the confirmation states the effect of each resolution', () => {
		const stuck = operation('0192f1aa-stuck', { kind: 'maintenance', step: 'restrict', targetMode: 'closed' })
		const resume = renderToStaticMarkup(<RecoveryEffect operation={stuck} resolution="resume" />)
		expect(resume).toContain('<code>closed</code>')
		expect(resume).toContain('resumes')
		expect(resume).toContain('<code>restrict</code>')
		expect(resume).toContain('<code>0192f1aa</code>')

		const open = renderToStaticMarkup(<RecoveryEffect operation={stuck} resolution="open" />)
		expect(open).toContain('<code>closed</code>')
		expect(open).toContain('opens the application')
		expect(open).toContain('does not continue')
	})
})

describe('starting and recovering through Control', () => {
	test('start maintenance calls data.start; a 501 reads as not available in this release', async () => {
		const calls: Call[] = []
		const outcome = await startMaintenance(
			createControlClient(fakeControl(calls, { 'data.start': refusal(501, 'not available') })),
			'notes',
			'prod',
			'closed',
		)
		expect(outcome).toEqual({ kind: 'not-in-release' })
		expect(calls).toEqual([{ method: 'data.start', input: { appId: 'notes', env: 'prod', kind: 'maintenance', mode: 'closed' } }])

		const done = await startMaintenance(createControlClient(fakeControl([], { 'data.start': result(operation('op-3')) })), 'notes', 'prod', 'read-only')
		expect(done).toEqual({ kind: 'done', operation: operation('op-3') })
	})

	test('recover calls data.recover; 404 and 403 read as not allowed, a 409 as Control says', async () => {
		const calls: Call[] = []
		expect(await recoverOperation(createControlClient(fakeControl(calls, { 'data.recover': refusal(404) })), 'notes', 'prod', 'op-2', 'open')).toEqual({
			kind: 'not-allowed',
		})
		expect(calls).toEqual([{ method: 'data.recover', input: { appId: 'notes', env: 'prod', operationId: 'op-2', resolution: 'open' } }])
		expect(await recoverOperation(createControlClient(fakeControl([], { 'data.recover': refusal(403) })), 'notes', 'prod', 'op-2', 'resume')).toEqual({
			kind: 'not-allowed',
		})
		expect(
			await recoverOperation(
				createControlClient(fakeControl([], { 'data.recover': refusal(409, 'an operation is running') })),
				'notes',
				'prod',
				'op-2',
				'resume',
			),
		).toEqual({ kind: 'refused', message: 'an operation is running' })
		expect(await recoverOperation(createControlClient(fakeControl([], { 'data.recover': refusal(501) })), 'notes', 'prod', 'op-2', 'resume')).toEqual({
			kind: 'not-in-release',
		})
	})

	test('not available in this release is a notice, not an error to retry', () => {
		const html = renderToStaticMarkup(<ActionOutcome outcome={{ kind: 'not-in-release' }} />)
		expect(html).toContain('not available in this release')
		expect(html).not.toContain('role="alert"')
		expect(html).not.toContain('Retry')
		expect(html).not.toContain('try again')

		const refused: DataAction = { kind: 'refused', message: 'an operation is running' }
		expect(renderToStaticMarkup(<ActionOutcome outcome={refused} />)).toContain('role="alert"')
		expect(renderToStaticMarkup(<ActionOutcome outcome={{ kind: 'not-allowed' }} />)).toContain('not allowed')
	})

	test('the content view reads data.content and returns the boot failure message', async () => {
		const calls: Call[] = []
		const content = await readBootFailure(
			createControlClient(
				fakeControl(calls, { 'data.content': result({ ...view(), bootFailure: { at: '2026-10-24T09:30:00.000Z', message: 'boom', stack: null } }) }),
			),
			'notes',
			'prod',
		)
		expect(content).toEqual({ kind: 'ok', value: { at: '2026-10-24T09:30:00.000Z', message: 'boom', stack: null } })
		expect(calls).toEqual([{ method: 'data.content', input: { appId: 'notes', env: 'prod' } }])
		expect(await readBootFailure(createControlClient(fakeControl([], { 'data.content': refusal(404) })), 'notes', 'prod')).toEqual({
			kind: 'not-allowed',
		})
	})
})

/** Every element of type `type` in a tree that is not rendered: what React mounts, and the key it mounts it under. */
function elementsOf(node: ReactNode, type: unknown): { key: string | null; props: unknown }[] {
	if (Array.isArray(node)) return node.flatMap((child: ReactNode) => elementsOf(child, type))
	if (!isValidElement<{ children?: ReactNode }>(node)) return []
	const own = node.type === type ? [{ key: node.key, props: node.props }] : []
	return [...own, ...elementsOf(node.props.children, type)]
}

const DATA_PATH = '/apps/notes/environments/prod/data'

const consoleCaller = (access: ConsoleAccessDto | null): ConsoleCaller => ({ access, iam: false, administersPeople: false })

describe('a data reader reaches the page', () => {
	test('a global or app-scoped data.read opens the data view without app.manage', () => {
		expect(workspaceGate(consoleCaller(holding(['data.read'])), DATA_PATH)).toEqual({ kind: 'page' })
		expect(workspaceGate(consoleCaller(holding([], { type: 'app', value: 'notes', actions: ['data.read'] })), DATA_PATH)).toEqual({ kind: 'page' })
		expect(workspaceGate(consoleCaller(holding([], { type: 'environment', value: 'prod', actions: ['data.read'] })), DATA_PATH)).toEqual({
			kind: 'page',
		})
	})

	test('the data reader gets no other application page, and a caller without data.read does not get the data view', () => {
		const reader = consoleCaller(holding(['data.read']))
		expect(workspaceGate(reader, '/apps/notes')).toEqual({ kind: 'no-access' })
		expect(workspaceGate(consoleCaller(holding(['data.read', 'deploy.read'])), '/apps/notes')).toEqual({ kind: 'not-available' })
		expect(workspaceGate(consoleCaller(holding(['app.manage'])), DATA_PATH)).toEqual({ kind: 'not-available' })
		expect(workspaceGate(consoleCaller(holding([])), DATA_PATH)).toEqual({ kind: 'no-access' })
		expect(workspaceGate(consoleCaller(holding(['app.manage'])), '/apps/notes')).toEqual({ kind: 'page' })
	})

	test('the back link to the application shows only to an app.manage holder', () => {
		const page = (access: ConsoleAccessDto | null) =>
			renderToStaticMarkup(
				<ConsoleAccessContext.Provider value={access}>
					<DataPage
						appId="notes"
						env="prod"
						data={{
							view: { kind: 'not-allowed' },
							operations: { kind: 'not-allowed' },
							backups: { kind: 'not-allowed' },
							schedule: { kind: 'not-allowed' },
						}}
						onChanged={() => undefined}
					/>
				</ConsoleAccessContext.Provider>,
			)
		expect(page(holding(['data.read']))).not.toContain('back-link')
		expect(page(holding([], { type: 'app', value: 'notes', actions: ['data.read'] }))).not.toContain('back-link')
	})
})

describe('state stays with its environment, failure and operation', () => {
	const data: Awaited<ReturnType<typeof loadDataView>> = {
		view: { kind: 'ok', value: view() },
		operations: page([operation('op-2')]),
		backups: backupPage([]),
		schedule: schedule(),
	}

	test('navigating to another environment mounts a fresh view: no fetched content, mode selection or 501 carries over', () => {
		const keyAt = (appId: string, env: string) =>
			elementsOf(DataPage({ appId, env, data, onChanged: () => undefined }), DataView).map((element) => element.key)
		expect(keyAt('notes', 'prod')).toHaveLength(1)
		expect(keyAt('notes', 'prod')).toEqual(keyAt('notes', 'prod'))
		expect(keyAt('notes', 'stage')).not.toEqual(keyAt('notes', 'prod'))
		expect(keyAt('blog', 'prod')).not.toEqual(keyAt('notes', 'prod'))
	})

	test('the boot message is bound to the failure it was read for', () => {
		const keyFor = (at: string) =>
			elementsOf(StateSection({ appId: 'notes', env: 'prod', view: view({ bootFailure: { at } }), readsContent: true }), BootFailureMessage)
				.map((element) => element.key)
		expect(keyFor('2026-10-24T09:30:00.000Z')).toEqual(['2026-10-24T09:30:00.000Z'])
		expect(keyFor('2026-10-24T10:00:00.000Z')).toEqual(['2026-10-24T10:00:00.000Z'])
	})

	test('the recovery control is bound to the operation it recovers', () => {
		const keyFor = (id: string) =>
			elementsOf(
				DataSections({
					appId: 'notes',
					env: 'prod',
					view: data.view,
					operations: page([operation(id)]),
					backups: data.backups,
					schedule: data.schedule,
					onChanged: () => undefined,
					manages: true,
					readsContent: false,
				}),
				RecoverControl,
			).map((element) => element.key)
		expect(keyFor('op-2')).toEqual(['op-2'])
		expect(keyFor('op-3')).toEqual(['op-3'])
	})
})

describe('capped counts, outages and content text', () => {
	test('a count at the cap reads as a lower bound, with the reason', () => {
		const html = markup(holding(['data.read']), {
			kind: 'ok',
			value: view({ database: { sizeBytes: 1, tables: [{ name: 'events', rows: 100_000 }] } }),
		})
		expect(html).toContain(`${(100_000).toLocaleString()}+`)
		expect(html).toContain('lower bound')
		expect(markup(holding(['data.read']), { kind: 'ok', value: view({ database: { sizeBytes: 1, tables: [{ name: 'events', rows: 99_999 }] } }) })).not
			.toContain(
				`${(99_999).toLocaleString()}+`,
			)
	})

	test('a 503 from Control reads as unavailable', async () => {
		const read = await loadDataView(
			createControlClient(
				fakeControl([], {
					'data.view': refusal(503),
					'data.operations.list': refusal(503),
					'data.backups.list': refusal(503),
					'data.backups.schedule': refusal(503),
				}),
			),
			'notes',
			'prod',
		)
		expect(read).toEqual({
			view: { kind: 'unavailable' },
			operations: { kind: 'unavailable' },
			backups: { kind: 'unavailable' },
			schedule: { kind: 'unavailable' },
		})
		expect(await readBootFailure(createControlClient(fakeControl([], { 'data.content': refusal(503) })), 'notes', 'prod')).toEqual({
			kind: 'unavailable',
		})
		expect(markup(holding(['data.read']), { kind: 'unavailable' })).toContain('could not read')
	})

	test("the application's boot text is rendered as text, never as markup", () => {
		const html = renderToStaticMarkup(
			<BootFailureText failure={{ at: '2026-10-24T09:30:00.000Z', message: '<script>alert(1)</script>', stack: '<img src=x onerror=alert(2)>' }} />,
		)
		expect(html).not.toContain('<script>')
		expect(html).not.toContain('<img')
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
		expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;')
	})
})

describe('backups', () => {
	test('the list shows each backup: time, size, parts, rehearsal, failures as codes, and expiry past 30 days', () => {
		const html = markup(
			holding(['data.read']),
			undefined,
			undefined,
			backupPage([
				backup('0192f1aa-backup'),
				backup('0192f1bb-failed', {
					state: 'failed',
					errorCode: 'rehearsal_failed',
					sizeBytes: null,
					parts: null,
					rehearsal: 'failed',
					rehearsalCode: 'hash_mismatch',
					createdAt: 1_780_000_000,
					expired: true,
				}),
				backup('0192f1cc-running', { state: 'running', rehearsal: 'pending', sizeBytes: null, parts: null, object: 'application-0192f1dd' }),
			], '0192f1cc-running'),
		)
		expect(html).toContain('<code>0192f1aa</code>')
		expect(html).toContain(fmtDate(1_790_000_000))
		expect(html).toContain('50.0 MiB')
		expect(html).toContain('>7<')
		expect(html).toContain('passed')
		expect(html).toContain('<code>hash_mismatch</code>')
		expect(html).toContain('<code>rehearsal_failed</code>')
		expect(html).toContain('expired')
		expect(html).toContain('pending')
		expect(html).toContain('<code>application-0192f1dd</code>')
		expect(html).toContain('The newest 3 backups')
	})

	test('no backups reads as none, and a refused list as not allowed', () => {
		expect(markup(holding(['data.read']), undefined, undefined, backupPage([]))).toContain('No backups yet')
		const refused = renderToStaticMarkup(
			<BackupsSection
				appId="notes"
				env="prod"
				backups={{ kind: 'not-allowed' }}
				schedule={{ kind: 'not-allowed' }}
				manages={false}
				onChanged={() => undefined}
			/>,
		)
		expect(refused).toContain('not allowed')
	})

	test('the schedule reads to data.read; its toggle shows only to a data.manage holder at the environment', () => {
		const reader = markup(holding(['data.read']))
		expect(reader).toContain('Daily backups')
		expect(reader).not.toContain('Turn off daily backups')
		expect(markup(holding([], { type: 'environment', value: 'stage', actions: ['data.manage'] }))).not.toContain('Turn off daily backups')

		expect(markup(holding(['data.manage']))).toContain('Turn off daily backups')
		const off = markup(holding([], { type: 'app', value: 'notes', actions: ['data.manage'] }), undefined, undefined, undefined, schedule(false))
		expect(off).toContain('Turn on daily backups')
		expect(off).toContain('the backup before a migration still runs')
	})

	test('the toggle calls data.backups.setSchedule; 404 and 403 read as not allowed, another refusal as Control says', async () => {
		const calls: Call[] = []
		const answer = { appId: 'notes', env: 'prod', daily: false, updatedAt: 1_790_000_000 }
		expect(await setBackupSchedule(createControlClient(fakeControl(calls, { 'data.backups.setSchedule': result(answer) })), 'notes', 'prod', false))
			.toEqual({ kind: 'done', schedule: answer })
		expect(calls).toEqual([{ method: 'data.backups.setSchedule', input: { appId: 'notes', env: 'prod', daily: false } }])
		for (const status of [403, 404]) {
			expect(
				await setBackupSchedule(createControlClient(fakeControl([], { 'data.backups.setSchedule': refusal(status) })), 'notes', 'prod', true),
			).toEqual({ kind: 'not-allowed' })
		}
		expect(
			await setBackupSchedule(createControlClient(fakeControl([], { 'data.backups.setSchedule': refusal(503, 'unavailable') })), 'notes', 'prod', true),
		).toEqual({ kind: 'refused', message: 'unavailable' })
	})
})

describe('the side restore', () => {
	const NOW = Date.parse('2026-10-25T12:00:00.000Z')
	const ZONE = 'Europe/Prague'
	const instant = (local: string, at: string, offset: string) => ({ at, offset, local, timeZone: ZONE })

	test('a local time within the last 30 days is the restore time: its UTC instant and the offset of the zone at it', () => {
		expect(parseRestoreTime('2026-10-24T13:00', NOW, ZONE)).toEqual({
			kind: 'ok',
			time: instant('2026-10-24 13:00', '2026-10-24T11:00:00.000Z', '+02:00'),
		})
		expect(parseRestoreTime('2026-09-25T14:01', NOW, ZONE)).toEqual({
			kind: 'ok',
			time: instant('2026-09-25 14:01', '2026-09-25T12:01:00.000Z', '+02:00'),
		})
		expect(parseRestoreTime('2026-10-25T09:15:30', NOW, 'UTC')).toEqual({
			kind: 'ok',
			time: { at: '2026-10-25T09:15:30.000Z', offset: '+00:00', local: '2026-10-25 09:15:30', timeZone: 'UTC' },
		})
	})

	test('no time, an impossible one, a future time, now, and a time older than 30 days are refused before anything is sent', () => {
		const choose = { kind: 'problem', problem: 'Choose the time to restore the data as of.' }
		for (const value of ['', 'not a time', '2026-02-30T10:00', '2026-13-01T10:00', '2026-10-24T24:00', '2026-10-24T10:60']) {
			expect(parseRestoreTime(value, NOW, ZONE)).toEqual(choose)
		}
		expect(parseRestoreTime('2026-10-25T13:01', NOW, ZONE)).toEqual({ kind: 'problem', problem: 'The time must lie in the past.' })
		expect(parseRestoreTime('2026-10-25T13:00', NOW, ZONE)).toEqual({ kind: 'problem', problem: 'The time must lie in the past.' })
		expect(parseRestoreTime('2026-09-25T13:59', NOW, ZONE)).toEqual({ kind: 'problem', problem: 'The time must lie within the last 30 days.' })
	})

	test('a local time the clocks skip (spring forward) is refused, not moved to another hour', () => {
		const spring = Date.parse('2027-04-01T12:00:00.000Z')
		expect(parseRestoreTime('2027-03-28T02:30', spring, ZONE)).toEqual({
			kind: 'problem',
			problem: '2027-03-28 02:30 does not exist in Europe/Prague: the clocks skip it. Choose another time.',
		})
		expect(parseRestoreTime('2027-03-28T01:59', spring, ZONE)).toEqual({
			kind: 'ok',
			time: instant('2027-03-28 01:59', '2027-03-28T00:59:00.000Z', '+01:00'),
		})
		expect(parseRestoreTime('2027-03-28T03:00', spring, ZONE)).toEqual({
			kind: 'ok',
			time: instant('2027-03-28 03:00', '2027-03-28T01:00:00.000Z', '+02:00'),
		})
	})

	test('a local time the clocks repeat (fall back) offers both instants, earliest first; one not yet past is not offered', () => {
		expect(parseRestoreTime('2026-10-25T02:30', NOW, ZONE)).toEqual({
			kind: 'ambiguous',
			choices: [
				instant('2026-10-25 02:30', '2026-10-25T00:30:00.000Z', '+02:00'),
				instant('2026-10-25 02:30', '2026-10-25T01:30:00.000Z', '+01:00'),
			],
		})
		expect(parseRestoreTime('2026-10-25T02:30', Date.parse('2026-10-25T01:00:00.000Z'), ZONE)).toEqual({
			kind: 'ok',
			time: instant('2026-10-25 02:30', '2026-10-25T00:30:00.000Z', '+02:00'),
		})
	})

	test('the choice between the two instants names each with its offset and UTC instant', () => {
		const html = renderToStaticMarkup(
			<RestoreOccurrences
				choices={[
					instant('2026-10-25 02:30', '2026-10-25T00:30:00.000Z', '+02:00'),
					instant('2026-10-25 02:30', '2026-10-25T01:30:00.000Z', '+01:00'),
				]}
				chosen="2026-10-25T01:30:00.000Z"
				onChoose={() => undefined}
			/>,
		)
		expect(html).toContain('Which 2026-10-25 02:30?')
		expect(html).toContain('The first, at UTC+02:00: <code>2026-10-25T00:30:00.000Z</code>')
		expect(html).toContain('The second, at UTC+01:00: <code>2026-10-25T01:30:00.000Z</code>')
		expect(html).toContain('checked="" value="2026-10-25T01:30:00.000Z"')
	})

	test('the confirmation names the local time, zone, offset and UTC instant, and says what the restore does', () => {
		const html = renderToStaticMarkup(<RestoreEffect time={instant('2026-10-25 02:30', '2026-10-25T01:30:00.000Z', '+01:00')} />)
		expect(html).toContain('<strong>2026-10-25 02:30</strong> (Europe/Prague, UTC+01:00)')
		expect(html).toContain('<code>2026-10-25T01:30:00.000Z</code>')
		expect(html).toContain('<code>read-only</code>')
		expect(html).toContain('consistent backup')
		expect(html).toContain('clone')
		expect(html).toContain('points ordinary traffic at the clone')
		expect(html).toContain('rewinds the original')
		expect(html).toContain('<code>inspect</code>')
		expect(html).toContain('kept for inspection')
	})

	test('the restore form shows only to a data.manage holder at the environment', () => {
		expect(markup(holding(['data.manage']))).toContain('type="datetime-local"')
		expect(markup(holding(['data.read']))).not.toContain('type="datetime-local"')
		expect(markup(holding([], { type: 'app', value: 'blog', actions: ['data.manage'] }))).not.toContain('type="datetime-local"')
	})

	test('starting a restore calls data.start with kind restore; a refusal is shown as Control says, a 404 as not allowed', async () => {
		const calls: Call[] = []
		const started = operation('op-r', { kind: 'restore', step: 'list', targetMode: 'open' })
		const at = '2026-10-24T08:30:00.000Z'
		expect(await startRestore(createControlClient(fakeControl(calls, { 'data.start': result(started) })), 'notes', 'prod', at)).toEqual({
			kind: 'done',
			operation: started,
		})
		expect(calls).toEqual([{ method: 'data.start', input: { appId: 'notes', env: 'prod', kind: 'restore', at } }])
		expect(
			await startRestore(
				createControlClient(fakeControl([], { 'data.start': refusal(409, "the environment's object list is full (16 names): no clone can be listed") })),
				'notes',
				'prod',
				at,
			),
		).toEqual({ kind: 'refused', message: "the environment's object list is full (16 names): no clone can be listed" })
		expect(await startRestore(createControlClient(fakeControl([], { 'data.start': refusal(404) })), 'notes', 'prod', at)).toEqual({
			kind: 'not-allowed',
		})
	})
})

describe('following a running operation', () => {
	const restore = (overrides: Partial<DataOperationDto>) => operation('0192f1aa-restore', { kind: 'restore', targetMode: 'open', ...overrides })

	/** Each step row's code and the state it reads in, in order. */
	const stepRows = (html: string): [string, string][] =>
		[...html.matchAll(/<tr><td><code>([a-z]+)<\/code><\/td><td>[^<]*<\/td><td><span[^>]*>.*?<\/span>([a-z ]+)<\/span><\/td><\/tr>/g)].map((
			match,
		) => [match[1] ?? '', match[2] ?? ''])

	test('a running restore shows its kind, step, generation and every step of the restore, done, current and pending', () => {
		const html = renderToStaticMarkup(<OperationProgress operation={restore({ step: 'import', generation: 9 })} />)
		expect(html).toContain('restore <code>0192f1aa</code>')
		expect(html).toContain('>9<')
		expect(stepRows(html)).toEqual([
			['list', 'done'],
			['restrict', 'done'],
			['backup', 'done'],
			['verify', 'done'],
			['import', 'current'],
			['promote', 'pending'],
			['point', 'pending'],
			['serve', 'pending'],
			['rewind', 'pending'],
			['check', 'pending'],
		])
	})

	test('a restore that failed before the clone served shows the way back to the original', () => {
		const html = renderToStaticMarkup(<OperationProgress operation={restore({ step: 'revert', state: 'running', errorCode: null })} />)
		expect(html).toContain('putting the original back')
		expect(stepRows(html)).toEqual([['revert', 'current'], ['open', 'pending']])
	})

	test('a restore that failed after the clone served says the clone keeps serving, with its code', () => {
		const html = renderToStaticMarkup(
			<OperationProgress operation={restore({ step: 'rewind', state: 'failed', errorCode: 'bookmark_unavailable', finishedAt: 1_790_000_100 })} />,
		)
		expect(html).toContain('<code>bookmark_unavailable</code>')
		expect(html).toContain('The clone keeps serving')
		expect(stepRows(html)[8]).toEqual(['rewind', 'stopped'])
	})

	test('a running operation of another kind shows its step without the restore steps', () => {
		const html = renderToStaticMarkup(<OperationProgress operation={operation('0192f1aa-maint', { step: 'restrict' })} />)
		expect(html).toContain('maintenance <code>0192f1aa</code>')
		expect(html).toContain('<code>restrict</code>')
		expect(stepRows(html)).toEqual([])
	})

	test('the page shows the running operation with the recovery choices to a data.manage holder only', () => {
		const running = page([restore({ step: 'point' })])
		const manager = markup(holding(['data.manage']), undefined, running)
		expect(manager).toContain('Running operation')
		expect(manager).toContain('Recover and resume')
		expect(manager).toContain('Recover and open')
		const reader = markup(holding(['data.read']), undefined, running)
		expect(reader).toContain('Running operation')
		expect(reader).not.toContain('Recover and')
		expect(markup(holding(['data.manage']), undefined, page([restore({ step: 'check', state: 'succeeded' })]))).not.toContain('Running operation')
	})

	test('the page reads again while the newest operation runs, and not once it finished', () => {
		const scheduled: number[] = []
		const schedule = (_callback: () => void, delayMs: number) => {
			scheduled.push(delayMs)
			return () => undefined
		}
		scheduleOperationPoll(page([restore({ step: 'import' })]), () => undefined, schedule)
		expect(scheduled).toHaveLength(1)
		scheduleOperationPoll(page([restore({ step: 'check', state: 'succeeded' }), restore({ id: 'older' })]), () => undefined, schedule)
		scheduleOperationPoll(page([]), () => undefined, schedule)
		scheduleOperationPoll({ kind: 'not-allowed' }, () => undefined, schedule)
		expect(scheduled).toHaveLength(1)
	})
})
