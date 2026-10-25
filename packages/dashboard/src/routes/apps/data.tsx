import { createPage, Link } from '@buzola/router'
import { CONTROL_ACTIONS, OPS_ROW_COUNT_CAP, type OpsContentView, type OpsView } from '@fabrika/control-contract'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { Chip, type Lamp, Status } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import {
	api,
	ApiError,
	type createControlClient,
	type CursorList,
	type DataBackupDto,
	type DataBackupScheduleDto,
	type DataOperationDto,
	type DataOperationResolution,
	type DataOperationState,
	type DataOperationStep,
	type DataRehearsalOutcome,
	type MaintenanceMode,
} from '../../lib/api'
import { holdsGlobally, mayDo, opensApplications } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import { fmtDate } from '../../lib/format'

// An application environment's data (ADR-0069, ADR-0070): what its object reports, its backups, the operations Control
// ran on it, and the maintenance, backup schedule, restore and recovery controls. consoleAccess only shows or hides a
// control; each procedure decides.

type ControlClient = ReturnType<typeof createControlClient>

/** Control's `data.view`: counts, sizes, timestamps and codes, never content. */
export type DataViewDto = OpsView
type BootFailureContent = NonNullable<OpsContentView['bootFailure']>

/** A read's outcome: Control answers a refusal as 404 (or 403), and an environment without an ops channel as 409. */
export type DataRead<T> =
	| { readonly kind: 'ok'; readonly value: T }
	| { readonly kind: 'not-allowed' }
	| { readonly kind: 'no-channel' }
	| { readonly kind: 'unavailable' }

/** A start or a recovery: a 501 is a release that cannot run it yet, never an error to retry. */
export type DataAction =
	| { readonly kind: 'done'; readonly operation: DataOperationDto }
	| { readonly kind: 'not-in-release' }
	| { readonly kind: 'not-allowed' }
	| { readonly kind: 'refused'; readonly message: string }

/** The operations the page lists: the newest page only, and it says so. */
const OPERATION_PAGE = 25

/** The backups the page lists: the newest page only, and it says so. */
const BACKUP_PAGE = 25

/** Control offers no restore older than a backup's retention, 30 days (ADR-0070 §5). */
const RESTORE_WINDOW_DAYS = 30
const RESTORE_WINDOW_MS = RESTORE_WINDOW_DAYS * 24 * 60 * 60 * 1000

/** How soon the page reads again while its newest operation runs. */
const OPERATION_POLL_MS = 5_000

/** A side restore's steps on its way to a serving clone (ADR-0070 §9), in Control's order. */
const RESTORE_STEPS: readonly { readonly step: DataOperationStep; readonly effect: string }[] = [
	{ step: 'list', effect: 'A deploy lists the clone object, so Control can reach it.' },
	{ step: 'restrict', effect: 'The serving object is frozen read-only.' },
	{ step: 'backup', effect: 'A consistent backup of it is taken.' },
	{ step: 'verify', effect: 'The backup is rehearsed.' },
	{ step: 'import', effect: 'The backup is imported into the clone.' },
	{ step: 'promote', effect: 'The clone is opened; the original is set to inspect.' },
	{ step: 'point', effect: 'A deploy points ordinary traffic at the clone.' },
	{ step: 'serve', effect: 'Control waits until the clone serves.' },
	{ step: 'rewind', effect: 'The original is rewound to the restore time.' },
	{ step: 'check', effect: "The rewound original's schema is checked." },
]

/** A restore that failed before its clone served goes back to the original. */
const RESTORE_BACK_STEPS: readonly { readonly step: DataOperationStep; readonly effect: string }[] = [
	{ step: 'revert', effect: 'A deploy points ordinary traffic back at the original.' },
	{ step: 'open', effect: 'The clone is set to inspect; the original is opened again.' },
]

/** The restore failures that leave the clone serving and the original in inspect (`packages/control/CLAUDE.md`). */
const CLONE_SERVING_CODES: readonly string[] = ['bookmark_unavailable', 'rewind_failed', 'unexpected_schema']

const MAINTENANCE_MODES: readonly { readonly mode: MaintenanceMode; readonly effect: string }[] = [
	{ mode: 'read-only', effect: 'reads only: a writing endpoint answers 503, and no job runs' },
	{ mode: 'closed', effect: "nothing but Control's ops requests" },
	{ mode: 'open', effect: 'everything, as usual' },
]

async function dataRead<T>(read: () => Promise<T>): Promise<DataRead<T>> {
	try {
		return { kind: 'ok', value: await read() }
	} catch (cause) {
		if (!(cause instanceof ApiError)) throw cause
		if (cause.httpStatus === 403 || cause.httpStatus === 404) return { kind: 'not-allowed' }
		if (cause.httpStatus === 409) return { kind: 'no-channel' }
		return { kind: 'unavailable' }
	}
}

async function dataAction(act: () => Promise<DataOperationDto>): Promise<DataAction> {
	try {
		return { kind: 'done', operation: await act() }
	} catch (cause) {
		if (!(cause instanceof ApiError)) throw cause
		if (cause.httpStatus === 501) return { kind: 'not-in-release' }
		if (cause.httpStatus === 403 || cause.httpStatus === 404) return { kind: 'not-allowed' }
		return { kind: 'refused', message: cause.message }
	}
}

export async function loadDataView(client: ControlClient, appId: string, env: string) {
	const [view, operations, backups, schedule] = await Promise.all([
		dataRead(() => client.data.view({ appId, env })),
		dataRead(() => client.data.operations.list({ appId, env, limit: OPERATION_PAGE })),
		dataRead(() => client.data.backups.list({ appId, env, limit: BACKUP_PAGE })),
		dataRead(() => client.data.backups.schedule({ appId, env })),
	])
	return { view, operations, backups, schedule }
}

/** A schedule change: Control answers a caller without `data.manage` as 404 (or 403). */
export type ScheduleAction =
	| { readonly kind: 'done'; readonly schedule: DataBackupScheduleDto }
	| { readonly kind: 'not-allowed' }
	| { readonly kind: 'refused'; readonly message: string }

export async function setBackupSchedule(client: ControlClient, appId: string, env: string, daily: boolean): Promise<ScheduleAction> {
	try {
		return { kind: 'done', schedule: await client.data.backups.setSchedule({ appId, env, daily }) }
	} catch (cause) {
		if (!(cause instanceof ApiError)) throw cause
		if (cause.httpStatus === 403 || cause.httpStatus === 404) return { kind: 'not-allowed' }
		return { kind: 'refused', message: cause.message }
	}
}

export function startRestore(client: ControlClient, appId: string, env: string, at: string): Promise<DataAction> {
	return dataAction(() => client.data.start({ appId, env, kind: 'restore', at }))
}

/** One instant a local time names: the UTC instant, the zone's offset at it, and the local time as entered. */
export interface RestoreInstant {
	readonly at: string
	/** `+02:00`, the zone's offset from UTC at `at`. */
	readonly offset: string
	readonly local: string
	readonly timeZone: string
}

/** A local time names one instant, two in a repeated hour (clocks go back), or none. */
export type RestoreTime =
	| { readonly kind: 'ok'; readonly time: RestoreInstant }
	| { readonly kind: 'ambiguous'; readonly choices: readonly [RestoreInstant, RestoreInstant] }
	| { readonly kind: 'problem'; readonly problem: string }

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?$/
const DAY_MS = 24 * 60 * 60 * 1000

/** The wall-clock time of `ms` in `timeZone`, as if it were UTC. */
function wallClock(ms: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(ms)
	const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value)
	return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) + (((ms % 1000) + 1000) % 1000)
}

function formatOffset(minutes: number): string {
	const sign = minutes < 0 ? '-' : '+'
	const abs = Math.abs(minutes)
	return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/** The instants whose wall-clock time in `timeZone` is exactly `wall`, earliest first. */
function instantsOf(wall: number, timeZone: string): number[] {
	const offsets = new Set([wallClock(wall - DAY_MS, timeZone) - (wall - DAY_MS), wallClock(wall + DAY_MS, timeZone) - (wall + DAY_MS)])
	return [...offsets].map((offset) => wall - offset).filter((ms) => wallClock(ms, timeZone) === wall).sort((a, b) => a - b)
}

/**
 * A `datetime-local` value, read in `timeZone` (the browser's), as the time a restore recovers the data as of: in the
 * past and within the window. A local time the zone skips is refused; one it repeats asks which occurrence is meant.
 * Control checks the past again.
 */
export function parseRestoreTime(value: string, nowMs: number, timeZone: string): RestoreTime {
	const match = LOCAL_TIME.exec(value.trim())
	const [year, month, day, hour, minute, second, fraction] = (match?.slice(1) ?? []).map((part) => Number(part ?? 0))
	const wall = match === null ? Number.NaN : Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 0, hour ?? 0, minute ?? 0, second ?? 0, fraction ?? 0)
	// Date.UTC normalises an impossible date (February 30) or hour (24:00) instead of refusing it.
	const normalised = new Date(wall)
	if (
		Number.isNaN(wall) || normalised.getUTCMonth() + 1 !== month || normalised.getUTCDate() !== day || normalised.getUTCHours() !== hour
		|| normalised.getUTCMinutes() !== minute
	) {
		return { kind: 'problem', problem: 'Choose the time to restore the data as of.' }
	}
	const local = value.trim().replace('T', ' ')
	const instants = instantsOf(wall, timeZone)
	if (instants.length === 0) {
		return { kind: 'problem', problem: `${local} does not exist in ${timeZone}: the clocks skip it. Choose another time.` }
	}
	if (instants.every((ms) => ms >= nowMs)) return { kind: 'problem', problem: 'The time must lie in the past.' }
	const inWindow = instants.filter((ms) => ms < nowMs && ms >= nowMs - RESTORE_WINDOW_MS)
	const times = inWindow.map((ms) => ({ at: new Date(ms).toISOString(), offset: formatOffset((wall - ms) / 60_000), local, timeZone }))
	const [earlier, later] = times
	if (earlier === undefined) return { kind: 'problem', problem: `The time must lie within the last ${RESTORE_WINDOW_DAYS} days.` }
	return later === undefined ? { kind: 'ok', time: earlier } : { kind: 'ambiguous', choices: [earlier, later] }
}

/** The zone the browser's `datetime-local` input is in. */
function browserTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** Reads the page again while its newest operation runs, so the page follows it; returns the cancel. */
export function scheduleOperationPoll(
	operations: DataRead<CursorList<DataOperationDto>>,
	invalidate: () => void,
	schedule: (callback: () => void, delayMs: number) => () => void,
): () => void {
	if (operations.kind !== 'ok' || operations.value.items[0]?.state !== 'running') return () => undefined
	return schedule(invalidate, OPERATION_POLL_MS)
}

export function startMaintenance(client: ControlClient, appId: string, env: string, mode: MaintenanceMode): Promise<DataAction> {
	return dataAction(() => client.data.start({ appId, env, kind: 'maintenance', mode }))
}

export function recoverOperation(
	client: ControlClient,
	appId: string,
	env: string,
	operationId: string,
	resolution: DataOperationResolution,
): Promise<DataAction> {
	return dataAction(() => client.data.recover({ appId, env, operationId, resolution }))
}

/** The boot failure with its message, which is content: `data.content.read` as a global grant only. */
export async function readBootFailure(client: ControlClient, appId: string, env: string): Promise<DataRead<BootFailureContent | null>> {
	const content = await dataRead(() => client.data.content({ appId, env }))
	return content.kind === 'ok' ? { kind: 'ok', value: content.value.bootFailure } : content
}

/**
 * The environment's stuck operation is its newest one, while it is still running or once it failed. Control resumes
 * only a running operation, and opens past a failed one.
 */
export function recoveryChoice(
	operations: readonly DataOperationDto[],
): { readonly operation: DataOperationDto; readonly resolutions: readonly DataOperationResolution[] } | null {
	const [newest] = operations
	if (newest === undefined) return null
	if (newest.state === 'running') return { operation: newest, resolutions: ['resume', 'open'] }
	if (newest.state === 'failed') return { operation: newest, resolutions: ['open'] }
	return null
}

export default createPage()
	.params({ id: 'string', env: 'string' })
	.loader(({ params }) => loadDataView(api, params.id, params.env))
	.route('/apps/:id/environments/:env/data')
	.render(({ data, params, invalidate }) => <DataPage appId={params.id} env={params.env} data={data} onChanged={invalidate} />)

export function DataPage(
	{ appId, env, data, onChanged }: {
		appId: string
		env: string
		data: Awaited<ReturnType<typeof loadDataView>>
		onChanged: () => void
	},
) {
	return (
		<>
			<div className="page-head">
				<BackLink appId={appId} />
				<h1>
					Data <Chip>{env}</Chip>
				</h1>
				<p className="hint">What this environment's application object holds and admits, and the operations Control ran on it.</p>
			</div>
			{/* Buzola reuses the page across params: nothing fetched, selected or refused may carry into another environment. */}
			<DataView
				key={JSON.stringify([appId, env])}
				appId={appId}
				env={env}
				view={data.view}
				operations={data.operations}
				backups={data.backups}
				schedule={data.schedule}
				onChanged={onChanged}
			/>
		</>
	)
}

/** A data reader may hold no global `app.manage`, so the application page is linked only for one who does. */
function BackLink({ appId }: { appId: string }) {
	if (!opensApplications(useConsoleAccess())) return null
	return (
		<Link to="apps/detail" params={{ id: appId }} className="back-link">
			<Icon name="chevron-left" size={14} />
			{appId}
		</Link>
	)
}

export function DataView(
	{ appId, env, view, operations, backups, schedule, onChanged }: {
		appId: string
		env: string
		view: DataRead<DataViewDto>
		operations: DataRead<CursorList<DataOperationDto>>
		backups: DataRead<CursorList<DataBackupDto>>
		schedule: DataRead<DataBackupScheduleDto>
		onChanged: () => void
	},
) {
	const access = useConsoleAccess()
	useEffect(
		() =>
			scheduleOperationPoll(operations, onChanged, (callback, delayMs) => {
				const timer = window.setTimeout(callback, delayMs)
				return () => window.clearTimeout(timer)
			}),
		[operations, onChanged],
	)
	return (
		<DataSections
			appId={appId}
			env={env}
			view={view}
			operations={operations}
			backups={backups}
			schedule={schedule}
			onChanged={onChanged}
			manages={mayDo(access, CONTROL_ACTIONS.DATA_MANAGE, { app: appId, env })}
			// Content is a global grant only (ADR-0069 §2): an unknown answer or a grant at the app or the environment does not offer it.
			readsContent={access !== null && holdsGlobally(access, CONTROL_ACTIONS.DATA_CONTENT_READ)}
		/>
	)
}

export function DataSections(
	{ appId, env, view, operations, backups, schedule, onChanged, manages, readsContent }: {
		appId: string
		env: string
		view: DataRead<DataViewDto>
		operations: DataRead<CursorList<DataOperationDto>>
		backups: DataRead<CursorList<DataBackupDto>>
		schedule: DataRead<DataBackupScheduleDto>
		onChanged: () => void
		manages: boolean
		readsContent: boolean
	},
) {
	const stuck = operations.kind === 'ok' ? recoveryChoice(operations.value.items) : null

	return (
		<>
			{view.kind === 'ok' ? <StateSection appId={appId} env={env} view={view.value} readsContent={readsContent} /> : <ReadProblem read={view} />}
			{stuck !== null && (
				<section>
					<div className="section-head">
						<h2>{stuck.operation.state === 'running' ? 'Running operation' : 'Failed operation'}</h2>
						<span className="spacer" />
						{manages && <RecoverControl key={stuck.operation.id} appId={appId} env={env} stuck={stuck} onChanged={onChanged} />}
					</div>
					<OperationProgress operation={stuck.operation} />
				</section>
			)}
			{view.kind === 'ok' && manages && <MaintenanceControl appId={appId} env={env} current={view.value.maintenance.mode} onChanged={onChanged} />}
			{view.kind === 'ok' && manages && <RestoreControl appId={appId} env={env} onChanged={onChanged} />}
			<BackupsSection appId={appId} env={env} backups={backups} schedule={schedule} manages={manages} onChanged={onChanged} />
			{view.kind === 'ok' && <ContentsSections view={view.value} />}
			<section>
				<div className="section-head">
					<h2>Operations</h2>
				</div>
				<p className="section-note">Maintenance, backups, migrations, restores and recoveries Control ran on this environment, newest first.</p>
				{operations.kind === 'ok' ? <OperationsTable page={operations.value} /> : <ReadProblem read={operations} />}
			</section>
		</>
	)
}

export function StateSection({ appId, env, view, readsContent }: { appId: string; env: string; view: DataViewDto; readsContent: boolean }) {
	const { maintenance, bootFailure } = view
	return (
		<section>
			<div className="detail-grid">
				<Field label="Mode">
					<Status lamp={modeLamp(maintenance.mode)}>{maintenance.mode}</Status>
				</Field>
				<Field label="Generation">
					{maintenance.generation === null ? <span className="muted">none yet</span> : maintenance.generation}
					{!maintenance.published && <div className="muted small">not yet published</div>}
				</Field>
				<Field label="Framework release">
					<code>{view.release}</code>
				</Field>
				<Field label="Database size">{fmtBytes(view.database.sizeBytes)}</Field>
			</div>
			<div className="section-head">
				<h2>Boot failure</h2>
			</div>
			{bootFailure === null
				? <p className="muted">No boot failure recorded.</p>
				: (
					<>
						<p>The application last failed to boot at {fmtIso(bootFailure.at)}.</p>
						{/* A new failure, after an invalidation, must not keep the message read for the last one. */}
						{readsContent && <BootFailureMessage key={bootFailure.at} appId={appId} env={env} />}
					</>
				)}
		</section>
	)
}

export function BootFailureMessage({ appId, env }: { appId: string; env: string }) {
	const [busy, setBusy] = useState(false)
	const [content, setContent] = useState<DataRead<BootFailureContent | null> | null>(null)

	async function show() {
		setBusy(true)
		setContent(await readBootFailure(api, appId, env))
		setBusy(false)
	}

	if (content === null) {
		return (
			<button type="button" className="small" onClick={show} disabled={busy}>
				{busy ? 'Reading…' : 'Show the error message'}
			</button>
		)
	}
	if (content.kind !== 'ok') return <ReadProblem read={content} />
	if (content.value === null) return <p className="muted">No boot failure recorded now.</p>
	return <BootFailureText failure={content.value} />
}

/** The application's own error text: content, rendered as text only. */
export function BootFailureText({ failure }: { failure: BootFailureContent }) {
	return <pre>{failure.stack === null ? failure.message : `${failure.message}\n\n${failure.stack}`}</pre>
}

function MaintenanceControl({ appId, env, current, onChanged }: { appId: string; env: string; current: MaintenanceMode; onChanged: () => void }) {
	const [mode, setMode] = useState<MaintenanceMode>(current === 'open' ? 'read-only' : 'open')
	const [busy, setBusy] = useState(false)
	const [outcome, setOutcome] = useState<DataAction | null>(null)
	const effect = MAINTENANCE_MODES.find((entry) => entry.mode === mode)?.effect

	async function start() {
		setBusy(true)
		const next = await startMaintenance(api, appId, env, mode)
		setOutcome(next)
		setBusy(false)
		if (next.kind === 'done') onChanged()
	}

	return (
		<section>
			<div className="section-head">
				<h2>Maintenance</h2>
			</div>
			<div className="toolbar">
				<select
					aria-label="Mode"
					value={mode}
					onChange={(event) => setMode(MAINTENANCE_MODES.find((entry) => entry.mode === event.target.value)?.mode ?? mode)}
					disabled={busy}
				>
					{MAINTENANCE_MODES.map((entry) => <option key={entry.mode} value={entry.mode}>{entry.mode}</option>)}
				</select>
				<button type="button" onClick={start} disabled={busy || outcome?.kind === 'not-in-release'}>
					{busy ? 'Starting…' : 'Start maintenance'}
				</button>
				{effect !== undefined && <span className="hint">The application admits {effect}.</span>}
			</div>
			{outcome !== null && <ActionOutcome outcome={outcome} />}
		</section>
	)
}

export function RecoverControl(
	{ appId, env, stuck, onChanged }: {
		appId: string
		env: string
		stuck: { readonly operation: DataOperationDto; readonly resolutions: readonly DataOperationResolution[] }
		onChanged: () => void
	},
) {
	const [confirming, setConfirming] = useState<DataOperationResolution | null>(null)
	const [outcome, setOutcome] = useState<DataAction | null>(null)

	async function recover(resolution: DataOperationResolution) {
		const next = await recoverOperation(api, appId, env, stuck.operation.id, resolution)
		setOutcome(next)
		if (next.kind === 'done') onChanged()
	}

	return (
		<>
			{stuck.resolutions.map((resolution) => (
				<button
					key={resolution}
					type="button"
					className="small"
					onClick={() => setConfirming(resolution)}
					disabled={outcome?.kind === 'not-in-release'}
				>
					{resolution === 'resume' ? 'Recover and resume' : 'Recover and open'}
				</button>
			))}
			{outcome !== null && <ActionOutcome outcome={outcome} />}
			{confirming !== null && (
				<ConfirmDialog
					title="Recover the environment"
					confirmLabel={confirming === 'resume' ? 'Recover and resume' : 'Recover and open'}
					body={<RecoveryEffect operation={stuck.operation} resolution={confirming} />}
					onConfirm={() => recover(confirming)}
					onClose={() => setConfirming(null)}
				/>
			)}
		</>
	)
}

/** What a recovery does, in the order Control does it (ADR-0069 §3). */
export function RecoveryEffect({ operation, resolution }: { operation: DataOperationDto; resolution: DataOperationResolution }) {
	const id = <code>{shortId(operation.id)}</code>
	return (
		<>
			<p>
				Control first fences the environment at a fresh generation in <code>closed</code>: the application answers nothing but Control's ops requests.
			</p>
			{resolution === 'resume'
				? (
					<p>
						It then resumes the {operation.kind} operation {id} from its recorded step{' '}
						<code>{operation.step}</code>. The environment ends in the mode that operation leaves it in.
					</p>
				)
				: (
					<p>
						It then opens the application at a new generation, so it admits every request again. The {operation.kind} operation {id}{' '}
						does not continue; if it is still running, it is recorded as failed.
					</p>
				)}
		</>
	)
}

/** An operation as it stands, and for a side restore each of its steps (ADR-0070 §9). */
export function OperationProgress({ operation }: { operation: DataOperationDto }) {
	return (
		<>
			<div className="detail-grid">
				<Field label="Operation">
					{operation.kind} <code>{shortId(operation.id)}</code>
				</Field>
				<Field label="Step">
					<code>{operation.step}</code>
				</Field>
				<Field label="Generation">{operation.generation}</Field>
				<Field label="Outcome">
					<Status lamp={operationLamp(operation.state)}>{operation.state}</Status>
					{operation.errorCode !== null && (
						<div className="muted small">
							<code>{operation.errorCode}</code>
						</div>
					)}
				</Field>
			</div>
			{operation.kind === 'restore' && <RestoreSteps operation={operation} />}
		</>
	)
}

function RestoreSteps({ operation }: { operation: DataOperationDto }) {
	const back = RESTORE_BACK_STEPS.some((entry) => entry.step === operation.step)
	const steps = back ? RESTORE_BACK_STEPS : RESTORE_STEPS
	const current = steps.findIndex((entry) => entry.step === operation.step)
	const cloneServes = operation.errorCode !== null && CLONE_SERVING_CODES.includes(operation.errorCode)
	return (
		<>
			{back && (
				<p className="notice">
					{operation.state === 'running'
						? 'The restore failed before the clone served: Control is putting the original back.'
						: 'The restore failed before the clone served, on its way back to the original.'}
				</p>
			)}
			{cloneServes && (
				<p className="notice">
					The clone keeps serving, and the original stays in <code>inspect</code>: nothing is lost. An operator decides what follows.
				</p>
			)}
			<Table
				colSpan={3}
				head={
					<tr>
						<th>Step</th>
						<th className="grow">What it does</th>
						<th>State</th>
					</tr>
				}
			>
				{steps.map((entry, index) => {
					const state = stepState(index, current, operation.state)
					return (
						<tr key={entry.step}>
							<td>
								<code>{entry.step}</code>
							</td>
							<td>{entry.effect}</td>
							<td>
								<Status lamp={state.lamp}>{state.label}</Status>
							</td>
						</tr>
					)
				})}
			</Table>
		</>
	)
}

function stepState(index: number, current: number, state: DataOperationState): { readonly lamp: Lamp; readonly label: string } {
	if (index < current || (index === current && state === 'succeeded')) return { lamp: 'ok', label: 'done' }
	if (index === current) return state === 'running' ? { lamp: 'run', label: 'current' } : { lamp: 'stop', label: 'stopped' }
	return { lamp: 'idle', label: 'pending' }
}

function RestoreControl({ appId, env, onChanged }: { appId: string; env: string; onChanged: () => void }) {
	const [value, setValue] = useState('')
	const [problem, setProblem] = useState<string | null>(null)
	const [choices, setChoices] = useState<readonly RestoreInstant[] | null>(null)
	const [chosen, setChosen] = useState<string | null>(null)
	const [confirming, setConfirming] = useState<RestoreInstant | null>(null)
	const [outcome, setOutcome] = useState<DataAction | null>(null)

	function change(next: string) {
		setValue(next)
		setChoices(null)
		setChosen(null)
	}

	function review(event: FormEvent) {
		event.preventDefault()
		const time = parseRestoreTime(value, Date.now(), browserTimeZone())
		if (time.kind === 'problem') {
			setProblem(time.problem)
			setChoices(null)
			return
		}
		if (time.kind === 'ambiguous') {
			const picked = time.choices.find((choice) => choice.at === chosen)
			if (picked === undefined) {
				setChoices(time.choices)
				setProblem(`${time.choices[0].local} occurs twice in ${time.choices[0].timeZone}: the clocks go back. Choose which one.`)
				return
			}
			setProblem(null)
			setConfirming(picked)
			return
		}
		setProblem(null)
		setConfirming(time.time)
	}

	async function restore(at: string) {
		const next = await startRestore(api, appId, env, at)
		setOutcome(next)
		if (next.kind === 'done') onChanged()
	}

	return (
		<section>
			<div className="section-head">
				<h2>Restore</h2>
			</div>
			<p className="section-note">
				Bring back the data as it was at a time within the last {RESTORE_WINDOW_DAYS}{' '}
				days. The application keeps serving its current data from a copy; the data of that time is kept beside it for inspection.
			</p>
			<form className="toolbar" onSubmit={review}>
				<input type="datetime-local" aria-label="Restore time" value={value} onChange={(event) => change(event.target.value)} />
				<button type="submit" disabled={outcome?.kind === 'not-in-release'}>Restore to this time…</button>
			</form>
			{problem !== null && <p className="error-text" role="alert">{problem}</p>}
			{choices !== null && <RestoreOccurrences choices={choices} chosen={chosen} onChoose={setChosen} />}
			{outcome !== null && <ActionOutcome outcome={outcome} />}
			{confirming !== null && (
				<ConfirmDialog
					title="Restore the data"
					confirmLabel="Start the restore"
					body={<RestoreEffect time={confirming} />}
					onConfirm={() => restore(confirming.at)}
					onClose={() => setConfirming(null)}
				/>
			)}
		</section>
	)
}

/** The two instants of a repeated local time, each with its offset, for the operator to pick one. */
export function RestoreOccurrences(
	{ choices, chosen, onChoose }: { choices: readonly RestoreInstant[]; chosen: string | null; onChoose: (at: string) => void },
) {
	return (
		<fieldset>
			<legend>Which {choices[0]?.local}?</legend>
			{choices.map((choice, index) => (
				<label key={choice.at}>
					<input type="radio" name="restore-occurrence" value={choice.at} checked={chosen === choice.at} onChange={() => onChoose(choice.at)} />
					{index === 0 ? 'The first' : 'The second'}, at UTC{choice.offset}: <code>{choice.at}</code>
				</label>
			))}
		</fieldset>
	)
}

/** What a side restore does, in the order Control does it (ADR-0070 §9). */
export function RestoreEffect({ time }: { time: RestoreInstant }) {
	return (
		<>
			<p>
				Control makes the data as it was at <strong>{time.local}</strong> ({time.timeZone}, UTC{time.offset}), the instant{' '}
				<code>{time.at}</code>, available in a side restore, in this order:
			</p>
			<ol>
				<li>
					It freezes the serving object <code>read-only</code>: a writing endpoint answers 503 until the clone serves.
				</li>
				<li>It takes a consistent backup of it and rehearses that backup.</li>
				<li>It imports the backup into a new clone object, which holds the data as it is now.</li>
				<li>It moves the pointer: a deploy points ordinary traffic at the clone, which serves from then on.</li>
				<li>
					It rewinds the original object to that time and leaves it in <code>inspect</code>: it serves nothing and is kept for inspection.
				</li>
			</ol>
			<p>
				Bringing rows from the rewound original into the clone is the application's own step. Going back is a new restore, never a switch.
			</p>
		</>
	)
}

export function BackupsSection(
	{ appId, env, backups, schedule, manages, onChanged }: {
		appId: string
		env: string
		backups: DataRead<CursorList<DataBackupDto>>
		schedule: DataRead<DataBackupScheduleDto>
		manages: boolean
		onChanged: () => void
	},
) {
	return (
		<section>
			<div className="section-head">
				<h2>Backups</h2>
			</div>
			<p className="section-note">
				Consistent backups of the application object, newest first. A backup succeeds only once its rehearsal, an import into a scratch object, passed.
				Control keeps each for {RESTORE_WINDOW_DAYS} days and offers none older for a restore.
			</p>
			{schedule.kind === 'ok' && (
				<ScheduleControl key={String(schedule.value.daily)} appId={appId} env={env} schedule={schedule.value} manages={manages} onChanged={onChanged} />
			)}
			{backups.kind === 'ok' ? <BackupsTable page={backups.value} /> : <ReadProblem read={backups} />}
		</section>
	)
}

function ScheduleControl(
	{ appId, env, schedule, manages, onChanged }: {
		appId: string
		env: string
		schedule: DataBackupScheduleDto
		manages: boolean
		onChanged: () => void
	},
) {
	const [busy, setBusy] = useState(false)
	const [outcome, setOutcome] = useState<ScheduleAction | null>(null)

	async function toggle() {
		setBusy(true)
		const next = await setBackupSchedule(api, appId, env, !schedule.daily)
		setOutcome(next)
		setBusy(false)
		if (next.kind === 'done') onChanged()
	}

	return (
		<>
			<div className="toolbar">
				<span>
					Daily backups <Status lamp={schedule.daily ? 'ok' : 'idle'}>{schedule.daily ? 'on' : 'off'}</Status>
				</span>
				{manages && (
					<button type="button" className="small" onClick={toggle} disabled={busy}>
						{schedule.daily ? 'Turn off daily backups' : 'Turn on daily backups'}
					</button>
				)}
				{!schedule.daily && <span className="hint">Off stops the daily backup only: the backup before a migration still runs.</span>}
			</div>
			{outcome?.kind === 'not-allowed' && <p className="notice" role="status">You are not allowed to do this on this environment.</p>}
			{outcome?.kind === 'refused' && <p className="error-text" role="alert">{outcome.message}</p>}
		</>
	)
}

function BackupsTable({ page }: { page: CursorList<DataBackupDto> }) {
	return (
		<>
			<Table
				colSpan={6}
				isEmpty={page.items.length === 0}
				empty={<EmptyState title="No backups yet" />}
				head={
					<tr>
						<th className="grow">Backup</th>
						<th>Taken</th>
						<th>Size</th>
						<th>Parts</th>
						<th>Rehearsal</th>
						<th>State</th>
					</tr>
				}
			>
				{page.items.map((backup) => (
					<tr key={backup.id}>
						<td>
							<code>{shortId(backup.id)}</code>
							<div className="muted small">
								of <code>{backup.object}</code>
							</div>
						</td>
						<td>
							{fmtDate(backup.createdAt)}
							{backup.preMigration && (
								<div>
									<Chip>before a migration</Chip>
								</div>
							)}
							{backup.expired && (
								<div>
									<Chip>expired</Chip>
								</div>
							)}
						</td>
						<td className="numeric">{backup.sizeBytes === null ? <span className="muted">none yet</span> : fmtBytes(backup.sizeBytes)}</td>
						<td className="numeric">{backup.parts === null ? <span className="muted">none yet</span> : backup.parts}</td>
						<td>
							<Status lamp={rehearsalLamp(backup.rehearsal)}>{backup.rehearsal}</Status>
							{backup.rehearsalCode !== null && (
								<div className="muted small">
									<code>{backup.rehearsalCode}</code>
								</div>
							)}
						</td>
						<td>
							<Status lamp={operationLamp(backup.state)}>{backup.state}</Status>
							{backup.errorCode !== null && (
								<div className="muted small">
									<code>{backup.errorCode}</code>
								</div>
							)}
						</td>
					</tr>
				))}
			</Table>
			{page.nextCursor !== null && <p className="hint">The newest {page.items.length} backups; older ones are not shown.</p>}
		</>
	)
}

export function ActionOutcome({ outcome }: { outcome: DataAction }) {
	switch (outcome.kind) {
		case 'done':
			return (
				<p className="notice" role="status">
					Started the {outcome.operation.kind} operation <code>{shortId(outcome.operation.id)}</code>.
				</p>
			)
		case 'not-in-release':
			return <p className="notice" role="status">This operation is not available in this release.</p>
		case 'not-allowed':
			return <p className="notice" role="status">You are not allowed to do this on this environment.</p>
		case 'refused':
			return <p className="error-text" role="alert">{outcome.message}</p>
	}
}

function ReadProblem({ read }: { read: Exclude<DataRead<unknown>, { kind: 'ok' }> }) {
	switch (read.kind) {
		case 'not-allowed':
			return <EmptyState icon="lock" title="You are not allowed to see this environment's data." />
		case 'no-channel':
			return (
				<EmptyState
					title="This environment has no ops channel yet."
					body="It needs a domain and a deploy at a framework release that serves one. Redeploy it to enable this view."
				/>
			)
		case 'unavailable':
			return <EmptyState title="Control could not read this environment's data." body="The environment did not give a usable answer. Try again later." />
	}
}

function ContentsSections({ view }: { view: DataViewDto }) {
	return (
		<>
			<section>
				<div className="section-head">
					<h2>Tables</h2>
				</div>
				<p className="section-note">
					The object counts each table's rows up to {OPS_ROW_COUNT_CAP.toLocaleString()}, so a table at that count shows it as a lower bound.
				</p>
				<Table
					colSpan={2}
					isEmpty={view.database.tables.length === 0}
					empty={<EmptyState title="No tables" />}
					head={
						<tr>
							<th className="grow">Table</th>
							<th>Rows</th>
						</tr>
					}
				>
					{view.database.tables.map((table) => (
						<tr key={table.name}>
							<td>
								<code>{table.name}</code>
							</td>
							<td className="numeric">{table.rows >= OPS_ROW_COUNT_CAP ? `${OPS_ROW_COUNT_CAP.toLocaleString()}+` : table.rows.toLocaleString()}</td>
						</tr>
					))}
				</Table>
			</section>
			<section>
				<div className="section-head">
					<h2>Jobs</h2>
				</div>
				<Table
					colSpan={4}
					isEmpty={view.jobs.length === 0}
					empty={<EmptyState title="No job has run" />}
					head={
						<tr>
							<th className="grow">Job</th>
							<th>Last run</th>
							<th>Finished</th>
							<th>Duration</th>
						</tr>
					}
				>
					{view.jobs.map((job) => (
						<tr key={job.job}>
							<td>
								<code>{job.job}</code>
							</td>
							<td>
								{job.lastStatus === null
									? <Status lamp="idle">running or never finished</Status>
									: <Status lamp={job.lastStatus === 'succeeded' ? 'ok' : 'stop'}>{job.lastStatus}</Status>}
							</td>
							<td>{job.lastFinishedAt === null ? <span className="muted">none</span> : fmtIso(job.lastFinishedAt)}</td>
							<td className="numeric">{job.lastDurationMs === null ? <span className="muted">none</span> : fmtMs(job.lastDurationMs)}</td>
						</tr>
					))}
				</Table>
			</section>
			<section>
				<div className="section-head">
					<h2>Files</h2>
				</div>
				<Table
					colSpan={3}
					isEmpty={view.files.length === 0}
					empty={<EmptyState title="No files" />}
					head={
						<tr>
							<th className="grow">Kind</th>
							<th>Status</th>
							<th>Count</th>
						</tr>
					}
				>
					{view.files.map((file) => (
						<tr key={`${file.kind}:${file.status}`}>
							<td>
								<code>{file.kind}</code>
							</td>
							<td>
								<Chip>{file.status}</Chip>
							</td>
							<td className="numeric">{file.count.toLocaleString()}</td>
						</tr>
					))}
				</Table>
			</section>
			<section>
				<div className="section-head">
					<h2>Webhook deliveries</h2>
				</div>
				<Table
					colSpan={3}
					isEmpty={view.webhooks.length === 0}
					empty={<EmptyState title="No webhook deliveries" />}
					head={
						<tr>
							<th className="grow">Webhook</th>
							<th>State</th>
							<th>Count</th>
						</tr>
					}
				>
					{view.webhooks.map((webhook) => (
						<tr key={`${webhook.webhook}:${webhook.state}`}>
							<td>
								<code>{webhook.webhook}</code>
							</td>
							<td>
								<Chip>{webhook.state}</Chip>
							</td>
							<td className="numeric">{webhook.count.toLocaleString()}</td>
						</tr>
					))}
				</Table>
			</section>
		</>
	)
}

function OperationsTable({ page }: { page: CursorList<DataOperationDto> }) {
	return (
		<>
			<Table
				colSpan={6}
				isEmpty={page.items.length === 0}
				empty={<EmptyState title="No operations yet" />}
				head={
					<tr>
						<th className="grow">Operation</th>
						<th>Step</th>
						<th>Mode</th>
						<th>Generation</th>
						<th>State</th>
						<th>Started</th>
					</tr>
				}
			>
				{page.items.map((operation) => (
					<tr key={operation.id}>
						<td>
							{operation.kind} <code>{shortId(operation.id)}</code>
						</td>
						<td>
							<code>{operation.step}</code>
						</td>
						<td>
							<code>{operation.targetMode}</code>
						</td>
						<td className="numeric">{operation.generation}</td>
						<td>
							<Status lamp={operationLamp(operation.state)}>{operation.state}</Status>
							{operation.errorCode !== null && (
								<div className="muted small">
									<code>{operation.errorCode}</code>
								</div>
							)}
						</td>
						<td>{fmtDate(operation.createdAt)}</td>
					</tr>
				))}
			</Table>
			{page.nextCursor !== null && <p className="hint">The newest {page.items.length} operations; older ones are not shown.</p>}
		</>
	)
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div>
			<h4>{label}</h4>
			{children}
		</div>
	)
}

function modeLamp(mode: MaintenanceMode): Lamp {
	switch (mode) {
		case 'open':
			return 'ok'
		case 'read-only':
			return 'run'
		case 'closed':
		case 'inspect':
			return 'stop'
	}
}

function rehearsalLamp(outcome: DataRehearsalOutcome): Lamp {
	switch (outcome) {
		case 'passed':
			return 'ok'
		case 'pending':
			return 'idle'
		case 'failed':
			return 'stop'
	}
}

function operationLamp(state: DataOperationState): Lamp {
	switch (state) {
		case 'succeeded':
			return 'ok'
		case 'running':
			return 'run'
		case 'failed':
			return 'stop'
	}
}

function shortId(id: string): string {
	return id.slice(0, 8)
}

/** The object's timestamps are ISO 8601; the console's formatter takes epoch seconds. */
function fmtIso(iso: string): string {
	return fmtDate(Date.parse(iso) / 1000)
}

function fmtMs(ms: number): string {
	return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function fmtBytes(bytes: number): string {
	const units = ['KiB', 'MiB', 'GiB', 'TiB']
	if (bytes < 1024) return `${bytes} B`
	let value = bytes / 1024
	let unit = 0
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024
		unit++
	}
	return `${value.toFixed(1)} ${units[unit]}`
}
