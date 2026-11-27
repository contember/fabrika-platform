import { describe, expect, test } from 'bun:test'
import { isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { dataTabEnvironment } from '../components/app/AppFrame'
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
import { type EnvironmentState, environmentState, needsDataAttention, readEnvironmentState, stateLabel, stateLamp } from '../lib/environment-state'
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
	MigrationSituation,
	OperationProgress,
	parseRestoreTime,
	readBootFailure,
	recoverOperation,
	recoveryChoice,
	RecoveryEffect,
	RestoreDialog,
	RestoreEffect,
	type RestoreInstant,
	restoreInstant,
	RestoreOccurrences,
	RestoreSituation,
	scheduleOperationPoll,
	setBackupSchedule,
	shortId,
	startMaintenance,
	startRestore,
	StateSection,
	StuckOperation,
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
	recordsBookmark: false,
	migrationFailure: null,
	revertRunId: null,
	candidateRecovered: false,
	rewound: false,
	rewindRefusal: null,
	rollbackAndOpen: false,
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

const MANAGE_ONLY_TEXT = ['What the application admits', 'Recover and', 'Turn off daily backups', 'Restore…']

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
		expect(markup(holding(['data.read']), { kind: 'ok', value: view({ bootFailure: null }) })).toContain(
			'<h4>Boot failure</h4><span class="muted">none</span>',
		)
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

	test('an environment without an ops channel says what the console cannot do there and when a deploy opens it', () => {
		const html = markup(holding(['data.read']), { kind: 'no-channel' })
		expect(html).toContain('The console cannot reach this environment')
		expect(html).toContain('Maintenance, restore and recovery are not available here')
		expect(html).toContain('a deploy at a current framework release makes them available')
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

	test('the maintenance control starts on the current mode, and Apply waits for another', () => {
		const html = markup(holding(['data.manage']))
		expect(html).toMatch(/checked="" value="read-only"/)
		expect(html).not.toMatch(/checked="" value="open"/)
		expect(html).toContain('<button type="submit" disabled="">Apply</button>')
		const inspect = markup(holding(['data.manage']), { kind: 'ok', value: view({ maintenance: { mode: 'inspect', generation: 9, published: true } }) })
		expect(inspect).not.toContain('checked=""')
		expect(inspect).toContain('where a restore left it')
	})

	test('a failed operation leads the page, with its code, and its recovery is the one filled button', () => {
		const failed = page([operation('op-2', { kind: 'restore', step: 'import', state: 'failed', errorCode: 'import_failed' })])
		const html = markup(holding(['data.manage']), undefined, failed)
		expect(html.indexOf('Restore failed at step <code>import</code>')).toBeLessThan(html.indexOf('<h4>Mode</h4>'))
		expect(html).toContain('<code>import_failed</code>')
		expect(html).toContain('class="notice notice-bad"')
		expect(html.match(/class="primary"/g)).toEqual(['class="primary"'])
		expect(html).toContain('class="primary">Recover and open</button>')
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
			stoppedBy: null,
		})
		expect(recoveryChoice([operation('op-2', { state: 'failed', errorCode: 'stale_generation' })])).toEqual({
			operation: operation('op-2', { state: 'failed', errorCode: 'stale_generation' }),
			resolutions: ['open'],
			stoppedBy: null,
		})
		expect(recoveryChoice([operation('op-2', { state: 'succeeded' }), operation('op-1')])).toBeNull()
		expect(recoveryChoice([])).toBeNull()
	})

	test('a refused open leads to the migration under it, which rolls back and opens when Control says it may', () => {
		const migration = operation('0192f1aa-migrate', {
			kind: 'migrate',
			step: 'rewind',
			targetMode: 'inspect',
			state: 'failed',
			errorCode: 'rewind_failed',
			recordsBookmark: true,
			migrationFailure: 'committed',
			rewound: true,
			rollbackAndOpen: true,
		})
		const refusedOpen = operation('0192f1aa-recover', {
			kind: 'recovery',
			step: 'open',
			state: 'failed',
			errorCode: 'rewound_before_rollback',
			recoversOperationId: migration.id,
			resolution: 'open',
		})
		const again = operation('0192f1aa-again', { ...refusedOpen, id: '0192f1aa-again', recoversOperationId: refusedOpen.id })
		expect(recoveryChoice([again, refusedOpen, migration])).toEqual({ operation: migration, resolutions: ['rollback', 'open'], stoppedBy: again })
		// An open of the environment refused for the same reason names no operation: the newest bookmark migration is the one.
		const maintenance = operation('0192f1aa-open', { kind: 'maintenance', step: 'open', state: 'failed', errorCode: 'rewound_before_rollback' })
		expect(recoveryChoice([maintenance, migration])?.operation).toBe(migration)
		// Not eligible: only the open past it.
		const kept = { ...migration, rewound: false, rollbackAndOpen: false }
		expect(recoveryChoice([refusedOpen, kept])).toEqual({ operation: kept, resolutions: ['open'], stoppedBy: refusedOpen })
		// A failed recovery whose operation is not on the page stays the target.
		expect(recoveryChoice([refusedOpen])).toEqual({ operation: refusedOpen, resolutions: ['open'], stoppedBy: null })

		const html = markup(holding(['data.manage']), undefined, page([refusedOpen, migration]))
		expect(html).toContain('Migration failed at step <code>rewind</code>')
		expect(html).toContain('The newest operation, recovery <code>-recover</code>, failed with <code>rewound_before_rollback</code>')
		expect(html).toContain('class="primary">Roll back and open</button>')
		expect(html).toContain('A later verify confirmed the rewind')
		expect(html).not.toContain('The rewind is unconfirmed')
		expect(html).toContain('>Recover and open</button>')
	})

	test('no recover control when nothing is stuck', () => {
		expect(markup(holding(['data.manage']), undefined, page([operation('op-2', { state: 'succeeded' })]))).not.toContain('Recover')
	})

	test('the confirmation states the effect of each resolution', () => {
		const stuck = operation('0192f1aa-stuck', { kind: 'maintenance', step: 'restrict', targetMode: 'closed' })
		const resume = renderToStaticMarkup(<RecoveryEffect operation={stuck} resolution="resume" />)
		expect(resume).toContain(
			'Afterwards the maintenance carries on where it stopped, and the environment ends up serving nothing but Control&#x27;s ops requests.',
		)
		expect(resume).toContain('<code>closed</code>')
		expect(resume).toContain('resumes')
		expect(resume).toContain('<code>restrict</code>')
		expect(resume).toContain('<code>aa-stuck</code>')

		const open = renderToStaticMarkup(<RecoveryEffect operation={stuck} resolution="open" />)
		expect(open).toContain('Afterwards the environment serves requests again, on its data as the stopped maintenance operation left it.')
		expect(open).toContain('<code>closed</code>')
		expect(open).toContain('opens the application')
		expect(open).toContain('does not continue')

		const failed = operation('0192f1aa-migrate', { kind: 'migrate', step: 'rewind', state: 'failed', recordsBookmark: true, rollbackAndOpen: true })
		const rollback = renderToStaticMarkup(<RecoveryEffect operation={failed} resolution="rollback" />)
		expect(rollback).toContain('on its data as it was before the migration')
		expect(rollback).toContain('<code>inspect</code>')
		expect(rollback).not.toContain('<code>closed</code>')
		expect(rollback).toContain('deploys the last succeeded commit again, as a new run')
		expect(rollback).toContain('when the data still holds the migration, the recovery stops')
		expect(rollback).toContain('The migration operation <code>-migrate</code> stays failed')

		const openPastMigration = renderToStaticMarkup(<RecoveryEffect operation={failed} resolution="open" />)
		expect(openPastMigration).toContain('admits every request again, with the version and data the migration left in place')
		expect(openPastMigration).toContain('Control refuses the open while the data was rewound and no rollback has settled')
		const resumeRestore = renderToStaticMarkup(<RecoveryEffect operation={{ ...stuck, kind: 'restore' }} resolution="resume" />)
		expect(resumeRestore).toContain('the environment ends as that operation leaves it')
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

const DATA_PATH = '/apps/notes/data/prod'
const LEGACY_DATA_PATH = '/apps/notes/environments/prod/data'

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

	test('the old data address stays a data view, so its redirect reaches a data reader', () => {
		expect(workspaceGate(consoleCaller(holding(['data.read'])), LEGACY_DATA_PATH)).toEqual({ kind: 'page' })
		expect(workspaceGate(consoleCaller(holding(['app.manage'])), LEGACY_DATA_PATH)).toEqual({ kind: 'not-available' })
	})

	test("a manager of one application opens that application's tabs and no other application", () => {
		const manager = consoleCaller(holding([], { type: 'app', value: 'notes', actions: ['app.manage'] }))
		for (const path of ['/apps/notes', '/apps/notes/settings', '/apps/notes/secrets', '/apps/notes/approvals']) {
			expect(workspaceGate(manager, path)).toEqual({ kind: 'page' })
		}
		expect(workspaceGate(manager, '/apps/vozka')).not.toEqual({ kind: 'page' })
		expect(workspaceGate(manager, '/apps/new')).not.toEqual({ kind: 'page' })
		expect(workspaceGate(manager, '/apps/%E0')).not.toEqual({ kind: 'page' })
		expect(workspaceGate(manager, DATA_PATH)).not.toEqual({ kind: 'page' })
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
				StuckOperation,
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
	test('the facts name the newest backup that passed, and whether a daily one follows', () => {
		const state = (backups: DataRead<CursorList<DataBackupDto>>, daily = schedule()) =>
			renderToStaticMarkup(<StateSection appId="notes" env="prod" view={view()} backups={backups} schedule={daily} readsContent={false} />)
		const html = state(backupPage([backup('bk-3', { state: 'failed', createdAt: 1_790_000_900 }), backup('bk-2', { createdAt: 1_790_000_000 })]))
		expect(html).toContain('<h4>Last backup</h4>')
		expect(html).toContain(`title="${fmtDate(1_790_000_000)}"`)
		expect(html).toContain('daily on')
		expect(state(backupPage([]), schedule(false))).toContain('none yet')
		expect(state(backupPage([]), schedule(false))).toContain('daily off')
		expect(state({ kind: 'not-allowed' })).toContain('not readable')
	})

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
		expect(html).toContain('<code>a-backup</code>')
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
				reachable
				onChanged={() => undefined}
			/>,
		)
		expect(refused).toContain('not allowed')
	})

	test('without a data channel no backup runs, so none is promised and the schedule is not offered', () => {
		const html = markup(holding(['data.manage']), { kind: 'no-channel' }, undefined, backupPage([]))
		expect(html).toContain('Daily backups do not run here.')
		expect(html).not.toContain('Turn off daily backups')
		expect(html).not.toContain('Daily backups <')
		expect(html).not.toContain('the next daily backup')
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

	test('the restore shows only to a data.manage holder at the environment, as a button that opens its dialog', () => {
		expect(markup(holding(['data.manage']))).toContain('Restore…')
		expect(markup(holding(['data.manage']))).not.toContain('type="datetime-local"')
		expect(markup(holding(['data.read']))).not.toContain('Restore…')
		expect(markup(holding([], { type: 'app', value: 'blog', actions: ['data.manage'] }))).not.toContain('Restore…')
	})

	test('the restore starts at the time, or in a repeated hour only once one of its two instants is chosen', () => {
		const choices: readonly [RestoreInstant, RestoreInstant] = [
			{ at: '2026-10-25T00:30:00.000Z', offset: '+02:00', local: '2026-10-25 02:30', timeZone: 'Europe/Prague' },
			{ at: '2026-10-25T01:30:00.000Z', offset: '+01:00', local: '2026-10-25 02:30', timeZone: 'Europe/Prague' },
		]
		expect(restoreInstant({ kind: 'ok', time: choices[0] }, null)).toEqual(choices[0])
		expect(restoreInstant({ kind: 'ambiguous', choices }, null)).toBeNull()
		expect(restoreInstant({ kind: 'ambiguous', choices }, choices[1].at)).toEqual(choices[1])
		expect(restoreInstant({ kind: 'ambiguous', choices }, 'another instant')).toBeNull()
		expect(restoreInstant({ kind: 'problem', problem: 'too old' }, choices[0].at)).toBeNull()
	})

	test('the restore dialog asks for the time first and offers no start until it names one instant', () => {
		const html = renderToStaticMarkup(<RestoreDialog appId="notes" env="prod" onStarted={() => undefined} onClose={() => undefined} />)
		expect(html).toContain('role="dialog"')
		expect(html).toContain('type="datetime-local"')
		expect(html).toMatch(/<button type="submit" class="danger strong" disabled="">Start the restore<\/button>/)
		expect(html).not.toContain('side restore')
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

test('a short id tells apart UUIDv7 records made a moment apart: their heads are the same time', () => {
	expect(shortId('019ac4f2-1b2c-7d10-8a11-5c3e9f1a2b01')).not.toBe(shortId('019ac4f2-1b40-7e22-9b33-0d4f8e2c3d02'))
})

describe('following a running operation', () => {
	const restore = (overrides: Partial<DataOperationDto>) => operation('0192f1aa-restore', { kind: 'restore', targetMode: 'open', ...overrides })
	const migration = (overrides: Partial<DataOperationDto>) =>
		operation('0192f1aa-migrate', { kind: 'migrate', step: 'migrate', targetMode: 'open', recordsBookmark: true, ...overrides })

	/** Each step row's code and the state it reads in, in order. */
	const stepRows = (html: string): [string, string][] =>
		[...html.matchAll(/<tr><td><code>([a-z]+)<\/code><\/td><td>[^<]*<\/td><td><span[^>]*>.*?<\/span>([a-z ]+)<\/span><\/td><\/tr>/g)].map((
			match,
		) => [match[1] ?? '', match[2] ?? ''])

	test('a running restore shows its kind, step, generation and every step of the restore, done, current and pending', () => {
		const html = renderToStaticMarkup(<OperationProgress operation={restore({ step: 'import', generation: 9 })} />)
		expect(html).toContain('restore <code>-restore</code>')
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
		const back = restore({ step: 'revert', state: 'running', errorCode: null })
		expect(renderToStaticMarkup(<RestoreSituation operation={back} />)).toContain('putting the original back')
		expect(stepRows(renderToStaticMarkup(<OperationProgress operation={back} />))).toEqual([['revert', 'current'], ['open', 'pending']])
	})

	test('a restore that failed after the clone served says the clone keeps serving, with its code', () => {
		const failed = restore({ step: 'rewind', state: 'failed', errorCode: 'bookmark_unavailable', finishedAt: 1_790_000_100 })
		const html = renderToStaticMarkup(<OperationProgress operation={failed} />)
		expect(html).toContain('<code>bookmark_unavailable</code>')
		expect(stepRows(html)[8]).toEqual(['rewind', 'stopped'])
		// What the data is left in leads the page, outside the folded steps.
		const page_ = markup(holding(['data.manage']), undefined, page([failed]))
		expect(page_.indexOf('The clone keeps serving')).toBeGreaterThan(-1)
		expect(page_.indexOf('The clone keeps serving')).toBeLessThan(page_.indexOf('Where it stands'))
		// Before the clone is promoted, the original still serves and keeps its data; after it, without a known code, nothing is claimed.
		expect(renderToStaticMarkup(<RestoreSituation operation={restore({ step: 'import', state: 'failed', errorCode: 'import_failed' })} />)).toContain(
			'ordinary traffic still goes to the original object, which keeps its data',
		)
		expect(renderToStaticMarkup(<RestoreSituation operation={restore({ step: 'check', state: 'failed', errorCode: 'schema_check_failed' })} />)).toBe(
			'',
		)
		expect(renderToStaticMarkup(<RestoreSituation operation={operation('op-9', { state: 'failed' })} />)).toBe('')
	})

	test('a running operation of another kind shows its step without the restore steps', () => {
		const html = renderToStaticMarkup(<OperationProgress operation={operation('0192f1aa-maint', { step: 'restrict' })} />)
		expect(html).toContain('maintenance <code>aa-maint</code>')
		expect(html).toContain('<code>restrict</code>')
		expect(stepRows(html)).toEqual([])
	})

	test('the page shows the running operation with the recovery choices to a data.manage holder only', () => {
		const running = page([restore({ step: 'point' })])
		const manager = markup(holding(['data.manage']), undefined, running)
		expect(manager).toContain('Restore running at step <code>point</code>')
		expect(manager.indexOf('Restore running')).toBeLessThan(manager.indexOf('<h4>Mode</h4>'))
		expect(manager).toContain('Recover and resume')
		expect(manager).toContain('Recover and open')
		const reader = markup(holding(['data.read']), undefined, running)
		expect(reader).toContain('Restore running at step')
		expect(reader).not.toContain('Recover and')
		expect(reader).toContain('Only a holder of data management on this environment can recover it.')
		expect(markup(holding(['data.manage']), undefined, page([restore({ step: 'check', state: 'succeeded' })]))).not.toContain('Restore running')
	})

	test('a migration without a read-only window shows deploy and migrate, and says the environment stays open', () => {
		const running = migration({ step: 'migrate' })
		const html = renderToStaticMarkup(<OperationProgress operation={running} />)
		expect(stepRows(html)).toEqual([['deploy', 'done'], ['migrate', 'current']])
		expect(renderToStaticMarkup(<MigrationSituation operation={running} />)).toContain('there is no read-only window and no backup')
		// The read-only phase keeps its single step and says nothing about a window.
		const readOnly = operation('0192f1aa-migrate', { kind: 'migrate', step: 'backup' })
		expect(stepRows(renderToStaticMarkup(<OperationProgress operation={readOnly} />))).toEqual([])
		expect(renderToStaticMarkup(<MigrationSituation operation={readOnly} />)).toBe('')
	})

	test("a failed migration names the new version's answer, the rollback deploy's steps and what the environment is left in", () => {
		const reverting = migration({ step: 'check', migrationFailure: 'rolled_back', revertRunId: 'run-back' })
		expect(renderToStaticMarkup(<MigrationSituation operation={reverting} />)).toContain('the data is as it was before the deploy')
		expect(renderToStaticMarkup(<MigrationSituation operation={reverting} />)).toContain('deploying the last succeeded commit back')
		expect(stepRows(renderToStaticMarkup(<OperationProgress operation={reverting} />))).toEqual([
			['revert', 'done'],
			['check', 'current'],
			['restrict', 'pending'],
		])

		const reverted = migration({ ...reverting, state: 'failed', errorCode: 'migration_reverted' })
		// A finished operation shows the step it never took as not taken, not pending.
		expect(stepRows(renderToStaticMarkup(<OperationProgress operation={reverted} />))).toEqual([
			['revert', 'done'],
			['check', 'stopped'],
			['restrict', 'not taken'],
		])
		const page_ = markup(holding(['data.manage']), undefined, page([reverted]))
		expect(page_).toContain('Migration failed at step <code>check</code>')
		expect(page_).toContain('<code>migration_reverted</code>')
		expect(page_.indexOf('The last succeeded commit serves again')).toBeGreaterThan(-1)
		expect(page_.indexOf('The last succeeded commit serves again')).toBeLessThan(page_.indexOf('Where it stands'))
		expect(page_).toContain('every step of the migration')

		// A committed migration that lost data is closed without a rollback deploy.
		const closed = migration({ step: 'restrict', state: 'failed', errorCode: 'migration_failed', migrationFailure: 'committed' })
		const closedHtml = renderToStaticMarkup(<MigrationSituation operation={closed} />)
		expect(closedHtml).toContain('<code>committed</code>')
		expect(closedHtml).toContain('the data is already migrated')
		expect(closedHtml).toContain('The environment is closed')
		expect(stepRows(renderToStaticMarkup(<OperationProgress operation={closed} />))).toEqual([['restrict', 'stopped']])

		const recovered = migration({
			...closed,
			step: 'restrict',
			migrationFailure: 'record_unwritable',
			revertRunId: 'run-back',
			candidateRecovered: true,
		})
		expect(renderToStaticMarkup(<MigrationSituation operation={recovered} />)).toContain('booted after all while the rollback deployed')

		const unconfirmed = migration({ state: 'failed', errorCode: 'migration_unconfirmed' })
		const unconfirmedHtml = renderToStaticMarkup(<MigrationSituation operation={unconfirmed} />)
		expect(unconfirmedHtml).toContain('did not confirm its migration before the deadline')
		expect(unconfirmedHtml).not.toContain('The new version answered')
		expect(renderToStaticMarkup(<MigrationSituation operation={migration({ migrationFailure: 'record_unwritable', step: 'revert' })} />)).toContain(
			'nothing migrated',
		)
	})

	test('a committed migration rewound in place shows the rewind before the rollback deploy, and what the data is left in', () => {
		const rewinding = migration({ step: 'rewind', targetMode: 'inspect', migrationFailure: 'committed' })
		expect(stepRows(renderToStaticMarkup(<OperationProgress operation={rewinding} />))).toEqual([
			['rewind', 'current'],
			['revert', 'pending'],
			['check', 'pending'],
			['restrict', 'pending'],
		])
		expect(renderToStaticMarkup(<MigrationSituation operation={rewinding} />)).toContain('the environment is in inspect')

		const deploying = migration({ step: 'check', targetMode: 'inspect', migrationFailure: 'committed', revertRunId: 'run-back', rewound: true })
		const deployingHtml = renderToStaticMarkup(<MigrationSituation operation={deploying} />)
		expect(deployingHtml).toContain('rewound the data to just before the migration')
		expect(deployingHtml).toContain('the environment opens once that version answers')

		const reverted = migration({ ...deploying, targetMode: 'open', state: 'failed', errorCode: 'migration_reverted' })
		expect(stepRows(renderToStaticMarkup(<OperationProgress operation={reverted} />))).toEqual([
			['rewind', 'done'],
			['revert', 'done'],
			['check', 'stopped'],
			['restrict', 'not taken'],
		])
		expect(renderToStaticMarkup(<MigrationSituation operation={reverted} />)).toContain('The last succeeded commit serves again')
	})

	test('a rewind that failed after three arms leaves the environment in inspect, which the console says', () => {
		const failed = migration({ step: 'rewind', targetMode: 'inspect', migrationFailure: 'committed', state: 'failed', errorCode: 'rewind_failed' })
		const html = renderToStaticMarkup(<OperationProgress operation={failed} />)
		expect(html).toContain('<code>rewind_failed</code>')
		expect(stepRows(html)).toEqual([
			['rewind', 'stopped'],
			['revert', 'not taken'],
			['check', 'not taken'],
			['restrict', 'not taken'],
		])
		const situation = renderToStaticMarkup(<MigrationSituation operation={failed} />)
		expect(situation).toContain('The rewind is unconfirmed')
		expect(situation).toContain('may still take at the next restart')
		expect(situation).not.toContain('stays applied')
		expect(situation).toContain('stays in inspect')
		expect(situation).not.toContain('The clone keeps serving')
	})

	test('a refused rewind names the refusal and leaves the step out; with a dataLoss line it closes without a rollback deploy', () => {
		const closed = migration({
			step: 'restrict',
			targetMode: 'closed',
			state: 'failed',
			errorCode: 'migration_failed',
			migrationFailure: 'committed',
			rewindRefusal: 'version_changed',
		})
		const html = renderToStaticMarkup(<MigrationSituation operation={closed} />)
		expect(html).toContain('refused to rewind the migration (<code>version_changed</code>), so nothing was rewound')
		expect(html).toContain('The environment is closed')
		expect(stepRows(renderToStaticMarkup(<OperationProgress operation={closed} />))).toEqual([['restrict', 'stopped']])

		const reverting = migration({ step: 'revert', migrationFailure: 'committed', rewindRefusal: 'not_rewindable', revertRunId: 'run-back' })
		expect(stepRows(renderToStaticMarkup(<OperationProgress operation={reverting} />))).toEqual([
			['revert', 'current'],
			['check', 'pending'],
			['restrict', 'pending'],
		])
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

describe("an environment's state lamp", () => {
	const env = { appId: 'notes', env: 'prod', publishedRunId: 'run-1' }
	const open = view({ maintenance: { mode: 'open', generation: 7, published: true }, bootFailure: null })

	test('the worst fact wins: offline, then a stuck operation, then a boot failure, then a restricted mode', () => {
		const failed = operation('op-1', { state: 'failed' })
		expect(environmentState({ ...env, suspendedAt: 1_790_000_000 }, open, [failed])).toEqual({ kind: 'suspended', at: 1_790_000_000 })
		expect(environmentState(env, view({ bootFailure: { at: '2026-10-24T08:00:00.000Z' } }), [failed])).toEqual({
			kind: 'operation',
			operation: failed,
		})
		expect(environmentState(env, view(), [])).toEqual({ kind: 'boot-failure', at: '2026-10-24T09:30:00.000Z' })
		expect(environmentState(env, view({ bootFailure: null }), [])).toEqual({ kind: 'mode', mode: 'read-only' })
		expect(environmentState(env, open, [operation('op-1', { state: 'succeeded' })])).toEqual({ kind: 'serving', published: true, source: 'object' })
		expect(environmentState({ ...env, publishedRunId: null }, null, [])).toEqual({ kind: 'serving', published: false, source: 'control' })
	})

	test('labels and lamps name the state, and only data states ask for the Data tab', () => {
		const running: EnvironmentState = { kind: 'operation', operation: operation('op-1') }
		expect([stateLabel(running), stateLamp(running), needsDataAttention(running)]).toEqual(['Maintenance running', 'run', true])
		const closed: EnvironmentState = { kind: 'mode', mode: 'closed' }
		expect([stateLabel(closed), stateLamp(closed), needsDataAttention(closed)]).toEqual(['Closed', 'stop', true])
		const offline: EnvironmentState = { kind: 'suspended', at: 1 }
		expect([stateLabel(offline), stateLamp(offline), needsDataAttention(offline)]).toEqual(['Offline', 'stop', false])
		const pending: EnvironmentState = { kind: 'reading' }
		expect([stateLabel(pending), stateLamp(pending), needsDataAttention(pending)]).toEqual(['Reading…', 'idle', false])
	})

	test("a provider without an ops channel still reads as serving from Control's facts; a refusal or an outage says so", async () => {
		const read = (answers: Record<string, () => Response>) => readEnvironmentState(createControlClient(fakeControl([], answers)), env)
		const published = await read({ 'data.view': refusal(409), 'data.operations.list': result({ items: [], nextCursor: null }) })
		expect(published).toEqual({ kind: 'serving', published: true, source: 'control' })
		expect(stateLabel(published)).toBe('Published')
		expect(stateLamp(published)).toBe('idle')
		expect(stateLamp({ kind: 'serving', published: true, source: 'object' })).toBe('ok')
		expect(await read({ 'data.view': result(open), 'data.operations.list': result({ items: [operation('op-2')], nextCursor: null }) })).toEqual({
			kind: 'operation',
			operation: operation('op-2'),
		})
		expect(await read({ 'data.view': refusal(403), 'data.operations.list': refusal(403) })).toEqual({ kind: 'unknown', reason: 'not-allowed' })
		expect(await read({ 'data.view': refusal(502), 'data.operations.list': result({ items: [], nextCursor: null }) })).toEqual({
			kind: 'unknown',
			reason: 'unavailable',
		})
	})

	test('the Data tab opens on the environment that needs a person, else prod, else the first', () => {
		const envs = [{ env: 'test' }, { env: 'prod' }, { env: 'stage' }]
		expect(dataTabEnvironment(envs, new Map())).toBe('prod')
		expect(dataTabEnvironment(envs, new Map([['stage', { kind: 'mode', mode: 'closed' }]]))).toBe('stage')
		expect(dataTabEnvironment([{ env: 'test' }], new Map())).toBe('test')
		expect(dataTabEnvironment([], new Map())).toBeNull()
	})
})
