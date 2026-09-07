import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnnotationPanel } from './components/AnnotationPanel'
import { Header } from './components/Header'
import { PhaseRail } from './components/PhaseRail'
import { PreviewPane } from './components/PreviewPane'
import { Workspace } from './components/Workspace'
import { canvasFilesForRevision } from './lib/canvasSelection'
import { daemon, sessionIdFromPath } from './lib/daemonClient'
import { FIXTURE_ARTIFACTS, FIXTURE_META, FIXTURE_PHASE_STATE, FIXTURE_SESSION_ID } from './lib/fixture'
import {
	type ActiveView,
	ActiveViewContext,
	AnnotationProvider,
	type PersistedState,
	RevisionContext,
	type RevisionInfo,
	SessionContext,
} from './lib/kernel'
import type { CanvasFileInfo, ConnStatus, PhaseId, PhaseState, RevisionMeta, SessionMeta } from './lib/types'

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown, required: readonly string[]): boolean {
	return isRecord(value) && required.every((key) => typeof value[key] === 'string')
}

function isResponseEntry(value: unknown): boolean {
	return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string'
		&& isStringRecord(value[1], ['id', 'type', 'label'])
}

function isFeedbackEntry(value: unknown): boolean {
	return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string'
		&& isStringRecord(value[1], ['id', 'markdown'])
}

function isPersistedState(value: unknown): value is PersistedState {
	if (!isRecord(value) || typeof value['generalNote'] !== 'string') return false
	if (
		!Array.isArray(value['annotations']) || !value['annotations'].every((item: unknown) => isStringRecord(item, ['id', 'snippet', 'note', 'createdAt']))
	) {
		return false
	}
	if (!Array.isArray(value['responses']) || !value['responses'].every(isResponseEntry)) return false
	const feedbackEntries = value['feedbackEntries']
	return feedbackEntries === undefined || (Array.isArray(feedbackEntries) && feedbackEntries.every(isFeedbackEntry))
}

function phaseHasPreview(phase: PhaseId): boolean {
	return phase === 'design' || phase === 'build'
}

const EMPTY_PHASE_STATE: PhaseState = {
	current: 'intake',
	index: 0,
	completed: [],
	reads: [],
	produces: [],
	gate: false,
	satisfied: false,
}

const LIVE_EMPTY_ARTIFACT = '_Nový projekt — zatím žádný krok. Otevři první gate z agenta._'

export function App(): JSX.Element {
	const sessionId = sessionIdFromPath() ?? FIXTURE_SESSION_ID

	const [status, setStatus] = useState<ConnStatus>('connecting')
	const [phaseState, setPhaseState] = useState<PhaseState>(EMPTY_PHASE_STATE)
	const [meta, setMeta] = useState<SessionMeta | null>(null)
	const [watching, setWatching] = useState(false)
	const [focused, setFocused] = useState<PhaseId>(EMPTY_PHASE_STATE.current)
	const [submitting, setSubmitting] = useState(false)
	const userFocused = useRef(false)
	const wsRef = useRef<WebSocket | null>(null)
	const rootRef = useRef<string | undefined>(undefined)

	useEffect(() => {
		let cancelled = false
		;(async () => {
			try {
				await daemon.health()
				if (cancelled) return
				const m = await daemon.meta(sessionId).catch(() => null)
				if (cancelled) return
				if (m) {
					setMeta(m)
					rootRef.current = m.projectRoot ? `${m.projectRoot}/.fabrika` : undefined
				}
				const ph = await daemon.phase(rootRef.current).catch(() => null)
				if (cancelled) return
				if (ph) {
					setPhaseState(ph)
					if (!userFocused.current) setFocused(ph.current)
				}
				setStatus('live')
			} catch {
				if (!cancelled) {
					setMeta(FIXTURE_META)
					setPhaseState(FIXTURE_PHASE_STATE)
					if (!userFocused.current) setFocused(FIXTURE_PHASE_STATE.current)
					setStatus('fixture')
				}
			}
		})()

		return () => {
			cancelled = true
		}
	}, [sessionId])

	useEffect(() => {
		if (status !== 'live') return

		let closed = false
		let reconnect: ReturnType<typeof setTimeout> | null = null

		const refresh = () => {
			daemon.meta(sessionId).then((m) => setMeta(m)).catch(() => {})
			daemon
				.phase(rootRef.current)
				.then((ph) => {
					setPhaseState(ph)
					if (!userFocused.current) setFocused(ph.current)
				})
				.catch(() => {})
		}

		const connect = () => {
			const ws = daemon.openSocket(sessionId, (msg) => {
				if (msg.type === 'plan-updated' || msg.type === 'revision-updated') {
					setSubmitting(false)
					refresh()
				} else if (msg.type === 'watcher-status') {
					setWatching(msg.watching)
				} else if (msg.type === 'phase-updated') {
					setSubmitting(false)
					refresh()
				} else if (msg.type === 'submit-ack') {
					setSubmitting(false)
					refresh()
				}
			})
			wsRef.current = ws
			ws.onopen = () => setStatus('live')
			ws.onclose = () => {
				if (closed) return
				setStatus('offline')
				reconnect = setTimeout(connect, 2000)
			}
		}
		connect()

		return () => {
			closed = true
			if (reconnect) clearTimeout(reconnect)
			wsRef.current?.close()
			wsRef.current = null
		}
	}, [status, sessionId])

	const [activeView, setActiveView] = useState<ActiveView>({ type: 'overview' })

	const onFocus = (id: PhaseId) => {
		userFocused.current = true
		setFocused(id)
	}

	const onSubmitGate = (feedback: string) => {
		const ws = wsRef.current
		if (ws && daemon.submitGate(ws, feedback)) setSubmitting(true)
	}

	const live = status === 'live'

	const focusedRev = useMemo<RevisionMeta | null>(() => {
		if (!meta) return null
		for (let i = meta.revisions.length - 1; i >= 0; i--) {
			if (meta.revisions[i]!.label === focused) return meta.revisions[i]!
		}
		return null
	}, [meta, focused])

	const gateName = phaseState.gateName ?? meta?.gate ?? null
	const isCurrentGate = live && focused === phaseState.current && !!gateName

	const gateFiles = useMemo<CanvasFileInfo[]>(() => {
		return canvasFilesForRevision(focusedRev)
	}, [focusedRev])

	const hasCanvas = live && !!focusedRev && gateFiles.length > 0
	const focusedRevision = focusedRev?.revision ?? meta?.currentRevision ?? 0
	const currentRevision = meta?.currentRevision ?? 0

	const gateSubmitted = isCurrentGate && !!focusedRev?.hasFeedback && !focusedRev?.feedbackConsumed
	const showWaiting = isCurrentGate && (submitting || gateSubmitted)
	const gateReadOnly = !isCurrentGate || showWaiting

	const artifact = status === 'fixture'
		? (FIXTURE_ARTIFACTS[focused] ?? '_No artifact for this phase yet._')
		: LIVE_EMPTY_ARTIFACT

	const revisions = useMemo<RevisionInfo[]>(
		() =>
			(meta?.revisions ?? []).map((r) => ({
				revision: r.revision,
				label: r.label ?? undefined,
				canvasFiles: r.canvasFiles.map((cf) => ({ filename: cf.filename })),
				createdAt: r.createdAt ?? new Date().toISOString(),
				hasFeedback: !!r.hasFeedback,
				feedbackConsumed: !!r.feedbackConsumed,
			})),
		[meta],
	)

	const showPreview = phaseHasPreview(focused)
	const cols = showPreview
		? 'grid-cols-[14rem_minmax(0,1fr)_22rem_auto]'
		: 'grid-cols-[14rem_minmax(0,1fr)_auto]'

	const body = (
		<div className={`grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] ${cols}`}>
			<PhaseRail state={phaseState} focused={focused} onFocus={onFocus} />
			<Workspace
				state={phaseState}
				focused={focused}
				canvas={hasCanvas ? { revision: focusedRevision, files: gateFiles } : null}
				artifact={artifact}
				isCurrentGate={isCurrentGate}
				sessionId={sessionId}
				live={live}
			/>
			{showPreview && <PreviewPane phase={focused} sessionId={sessionId} live={live} />}
			<AnnotationPanel
				gateName={gateName}
				hasGate={hasCanvas}
				isCurrentGate={isCurrentGate}
				onSubmit={onSubmitGate}
			/>
		</div>
	)

	return (
		<div className="flex h-screen w-screen flex-col overflow-hidden bg-bg-base text-text-primary">
			<Header sessionId={sessionId} status={status} watching={watching} />
			{hasCanvas
				? (
					<SessionContext.Provider value={sessionId}>
						<RevisionContext.Provider
							value={{
								currentRevision,
								selectedRevision: focusedRevision,
								revisions,
								setSelectedRevision: () => {},
								isReadOnly: gateReadOnly,
								compareRevision: null,
								setCompareRevision: () => {},
								agentWatching: watching,
							}}
						>
							<ActiveViewContext.Provider
								value={{
									activeView,
									setActiveView,
									openFiles: [],
									closeFile: () => {},
									canvasFiles: gateFiles.map((cf) => cf.filename),
								}}
							>
								<AnnotationProvider
									key={focusedRevision}
									sessionId={sessionId}
									revision={focusedRevision}
									isReadOnly={gateReadOnly}
									draftPhase="current"
									loadState={(sid, rev) => daemon.getResponses(sid, rev, isPersistedState)}
									saveState={(sid, rev, state) => {
										void daemon.saveResponses(sid, rev, state)
									}}
								>
									{body}
								</AnnotationProvider>
							</ActiveViewContext.Provider>
						</RevisionContext.Provider>
					</SessionContext.Provider>
				)
				: body}
		</div>
	)
}
