import { describe, expect, test } from 'bun:test'
import { isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { type ConsoleAccessDto, type ControlFetch, createControlClient, type CursorList, type DataOperationDto } from '../lib/api'
import type { ConsoleCaller } from '../lib/console-access'
import { ConsoleAccessContext } from '../lib/console-caller'
import { fmtDate } from '../lib/format'
import { workspaceGate } from '../routes/_layout'
import {
	ActionOutcome,
	BootFailureMessage,
	BootFailureText,
	type DataAction,
	DataPage,
	type DataRead,
	DataSections,
	DataView,
	type DataViewDto,
	loadDataView,
	readBootFailure,
	RecoverControl,
	recoverOperation,
	recoveryChoice,
	RecoveryEffect,
	startMaintenance,
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

const holding = (global: string[], scope?: { type: 'app' | 'environment'; value: string; actions: string[] }): ConsoleAccessDto => ({
	principal: null,
	global,
	scopes: scope === undefined ? [] : [scope],
})

const markup = (
	access: ConsoleAccessDto | null,
	read: DataRead<DataViewDto> = { kind: 'ok', value: view() },
	operations: DataRead<CursorList<DataOperationDto>> = page([operation('op-2')]),
): string =>
	renderToStaticMarkup(
		<ConsoleAccessContext.Provider value={access}>
			<DataView appId="notes" env="prod" view={read} operations={operations} onChanged={() => undefined} />
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

const MANAGE_ONLY_TEXT = ['Start maintenance', 'Recover']

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
		const html = markup(holding(['data.manage', 'data.content.read']), { kind: 'not-allowed' }, { kind: 'not-allowed' })
		expect(html).toContain('not allowed')
		expect(html).not.toContain('role="alert"')
		for (const text of [...MANAGE_ONLY_TEXT, 'Show the error message']) expect(html).not.toContain(text)
	})

	test('an environment without an ops channel says to redeploy', () => {
		expect(markup(holding(['data.read']), { kind: 'no-channel' })).toContain('Redeploy')
	})

	test('the loader reads the view and the operations, and maps 404 and 403 to not-allowed, 409 to no channel', async () => {
		const calls: Call[] = []
		const ok = await loadDataView(
			createControlClient(fakeControl(calls, { 'data.view': result(view()), 'data.operations.list': result({ items: [], nextCursor: null }) })),
			'notes',
			'prod',
		)
		expect(ok.view).toEqual({ kind: 'ok', value: view() })
		expect(ok.operations).toEqual({ kind: 'ok', value: { items: [], nextCursor: null } })
		expect(calls).toEqual([
			{ method: 'data.view', input: { appId: 'notes', env: 'prod' } },
			{ method: 'data.operations.list', input: { appId: 'notes', env: 'prod', limit: 25 } },
		])

		const hidden = await loadDataView(
			createControlClient(fakeControl([], { 'data.view': refusal(404), 'data.operations.list': refusal(403) })),
			'notes',
			'prod',
		)
		expect(hidden).toEqual({ view: { kind: 'not-allowed' }, operations: { kind: 'not-allowed' } })

		const unreached = await loadDataView(
			createControlClient(fakeControl([], { 'data.view': refusal(409), 'data.operations.list': refusal(502) })),
			'notes',
			'prod',
		)
		expect(unreached).toEqual({ view: { kind: 'no-channel' }, operations: { kind: 'unavailable' } })
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
					<DataPage appId="notes" env="prod" data={{ view: { kind: 'not-allowed' }, operations: { kind: 'not-allowed' } }} onChanged={() => undefined} />
				</ConsoleAccessContext.Provider>,
			)
		expect(page(holding(['data.read']))).not.toContain('back-link')
		expect(page(holding([], { type: 'app', value: 'notes', actions: ['data.read'] }))).not.toContain('back-link')
	})
})

describe('state stays with its environment, failure and operation', () => {
	const data: Awaited<ReturnType<typeof loadDataView>> = { view: { kind: 'ok', value: view() }, operations: page([operation('op-2')]) }

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
			createControlClient(fakeControl([], { 'data.view': refusal(503), 'data.operations.list': refusal(503) })),
			'notes',
			'prod',
		)
		expect(read).toEqual({ view: { kind: 'unavailable' }, operations: { kind: 'unavailable' } })
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
