import { createPage, Link } from '@buzola/router'
import { CONTROL_ACTIONS, OPS_ROW_COUNT_CAP, type OpsContentView, type OpsView } from '@fabrika/control-contract'
import { type ReactNode, useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { Chip, type Lamp, Status } from '../../components/Status'
import { EmptyState, Table } from '../../components/Table'
import {
	api,
	ApiError,
	type createControlClient,
	type CursorList,
	type DataOperationDto,
	type DataOperationResolution,
	type DataOperationState,
	type MaintenanceMode,
} from '../../lib/api'
import { holdsGlobally, mayDo, opensApplications } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import { fmtDate } from '../../lib/format'

// An application environment's data (ADR-0069): what its object reports, the operations Control ran on it, and the
// maintenance and recovery controls. consoleAccess only shows or hides a control; each procedure decides.

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
	const [view, operations] = await Promise.all([
		dataRead(() => client.data.view({ appId, env })),
		dataRead(() => client.data.operations.list({ appId, env, limit: OPERATION_PAGE })),
	])
	return { view, operations }
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
			<DataView key={JSON.stringify([appId, env])} appId={appId} env={env} view={data.view} operations={data.operations} onChanged={onChanged} />
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
	{ appId, env, view, operations, onChanged }: {
		appId: string
		env: string
		view: DataRead<DataViewDto>
		operations: DataRead<CursorList<DataOperationDto>>
		onChanged: () => void
	},
) {
	const access = useConsoleAccess()
	return (
		<DataSections
			appId={appId}
			env={env}
			view={view}
			operations={operations}
			onChanged={onChanged}
			manages={mayDo(access, CONTROL_ACTIONS.DATA_MANAGE, { app: appId, env })}
			// Content is a global grant only (ADR-0069 §2): an unknown answer or a grant at the app or the environment does not offer it.
			readsContent={access !== null && holdsGlobally(access, CONTROL_ACTIONS.DATA_CONTENT_READ)}
		/>
	)
}

export function DataSections(
	{ appId, env, view, operations, onChanged, manages, readsContent }: {
		appId: string
		env: string
		view: DataRead<DataViewDto>
		operations: DataRead<CursorList<DataOperationDto>>
		onChanged: () => void
		manages: boolean
		readsContent: boolean
	},
) {
	const stuck = operations.kind === 'ok' ? recoveryChoice(operations.value.items) : null

	return (
		<>
			{view.kind === 'ok'
				? (
					<>
						<StateSection appId={appId} env={env} view={view.value} readsContent={readsContent} />
						{manages && <MaintenanceControl appId={appId} env={env} current={view.value.maintenance.mode} onChanged={onChanged} />}
						<ContentsSections view={view.value} />
					</>
				)
				: <ReadProblem read={view} />}
			<section>
				<div className="section-head">
					<h2>Operations</h2>
					<span className="spacer" />
					{manages && stuck !== null && <RecoverControl key={stuck.operation.id} appId={appId} env={env} stuck={stuck} onChanged={onChanged} />}
				</div>
				<p className="section-note">Maintenance, backups, migrations and recoveries Control ran on this environment, newest first.</p>
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
