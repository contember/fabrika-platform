import { resolve } from 'path'
import { BASE_URL, SESSIONS_DIR, TIMEOUT_MS, WS_URL } from './config'
import type { PhaseState } from './derive'
import { PHASES } from './phases'

const HEALTH_TIMEOUT_MS = 1000

export interface HealthInfo {
	ok: boolean
	version?: string
	pid?: number
	dataDir?: string
	sessionsDir?: string
	sessions?: number | string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined
}

function stringArray(value: unknown): string[] | null {
	if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string')) return null
	return value
}

function parseHealthInfo(value: unknown): HealthInfo | null {
	if (!isRecord(value) || value['ok'] !== true) return null
	const sessions = typeof value['sessions'] === 'number' ? value['sessions'] : stringArray(value['sessions']) ?? undefined
	return {
		ok: true,
		...(optionalString(value['version']) === undefined ? {} : { version: optionalString(value['version']) }),
		...(optionalNumber(value['pid']) === undefined ? {} : { pid: optionalNumber(value['pid']) }),
		...(optionalString(value['dataDir']) === undefined ? {} : { dataDir: optionalString(value['dataDir']) }),
		...(optionalString(value['sessionsDir']) === undefined ? {} : { sessionsDir: optionalString(value['sessionsDir']) }),
		...(sessions === undefined ? {} : { sessions }),
	}
}

function isPhaseId(value: unknown): value is PhaseState['current'] {
	return typeof value === 'string' && PHASES.some((phase) => phase.id === value)
}

function parsePhaseState(value: unknown): PhaseState | null {
	if (!isRecord(value) || !isPhaseId(value['current']) || typeof value['index'] !== 'number') return null
	const rawCompleted = value['completed']
	const completed = Array.isArray(rawCompleted) ? rawCompleted.filter(isPhaseId) : null
	const reads = stringArray(value['reads'])
	const produces = stringArray(value['produces'])
	if (completed === null || !Array.isArray(rawCompleted) || completed.length !== rawCompleted.length || reads === null || produces === null) {
		return null
	}
	if (typeof value['gate'] !== 'boolean' || typeof value['satisfied'] !== 'boolean') return null
	return {
		current: value['current'],
		index: value['index'],
		completed,
		reads,
		produces,
		gate: value['gate'],
		satisfied: value['satisfied'],
	}
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined
	const result: Record<string, string> = {}
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== 'string') return undefined
		result[key] = entry
	}
	return result
}

function parsePlanResult(value: unknown): PlanResult {
	if (!isRecord(value) || typeof value['ok'] !== 'boolean') return { ok: false, error: 'Invalid daemon response' }
	return {
		ok: value['ok'],
		...(optionalString(value['browserUrl']) === undefined ? {} : { browserUrl: optionalString(value['browserUrl']) }),
		...(optionalNumber(value['revision']) === undefined ? {} : { revision: optionalNumber(value['revision']) }),
		...(optionalBoolean(value['isNew']) === undefined ? {} : { isNew: optionalBoolean(value['isNew']) }),
		...(stringArray(value['canvasFiles']) === null ? {} : { canvasFiles: stringArray(value['canvasFiles']) ?? [] }),
		...(optionalString(value['gate']) === undefined ? {} : { gate: optionalString(value['gate']) }),
		...(optionalString(value['error']) === undefined ? {} : { error: optionalString(value['error']) }),
		...(stringRecord(value['errors']) === undefined ? {} : { errors: stringRecord(value['errors']) }),
	}
}

export async function health(): Promise<HealthInfo | null> {
	try {
		const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
		const data: unknown = await res.json()
		return parseHealthInfo(data)
	} catch {
		return null
	}
}

export async function isDaemonRunning(): Promise<boolean> {
	const info = await health()
	return info !== null && healthMatchesDataRoot(info)
}

export function healthMatchesDataRoot(
	info: HealthInfo,
	expectedSessionsDir: string = SESSIONS_DIR,
): boolean {
	if (!info.sessionsDir) return false
	return comparablePath(info.sessionsDir) === comparablePath(expectedSessionsDir)
}

function comparablePath(path: string): string {
	const absolute = resolve(path)
	return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export async function fetchPhase(fabrikaDir: string, sessionId?: string): Promise<PhaseState | null> {
	try {
		let url = `${BASE_URL}/api/phase?root=${encodeURIComponent(fabrikaDir)}`
		if (sessionId) url += `&session=${encodeURIComponent(sessionId)}`
		const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
		if (!res.ok) return null
		const data: unknown = await res.json()
		return parsePhaseState(data)
	} catch {
		return null
	}
}

export interface PlanResult {
	ok: boolean
	browserUrl?: string
	revision?: number
	isNew?: boolean
	canvasFiles?: string[]
	gate?: string
	error?: string
	errors?: Record<string, string>
}

export type PlanSource =
	| { view: string; directory?: never }
	| { directory: string; view?: never }

export async function pushPlan(
	sessionId: string,
	body: PlanSource & { projectRoot: string; label?: string; gate?: string },
): Promise<PlanResult & { reachable: boolean }> {
	try {
		const res = await fetch(`${BASE_URL}/api/session/${sessionId}/plan`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
		const data = parsePlanResult(await res.json())
		return { ...data, reachable: true }
	} catch (e) {
		return { ok: false, reachable: false, error: String(e) }
	}
}

export async function peekFeedback(sessionId: string): Promise<string | null> {
	try {
		const metaRes = await fetch(`${BASE_URL}/api/session/${sessionId}/meta`, {
			signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
		})
		if (!metaRes.ok) return null
		const meta: unknown = await metaRes.json()
		if (!isRecord(meta) || !Array.isArray(meta['revisions'])) return null
		const revisions = meta['revisions']
		for (let i = revisions.length - 1; i >= 0; i--) {
			const revision = revisions[i]
			if (!isRecord(revision) || typeof revision['revision'] !== 'number') continue
			if (revision['hasFeedback'] === true && revision['feedbackConsumed'] !== true) {
				const fbRes = await fetch(`${BASE_URL}/api/session/${sessionId}/revision/${revision['revision']}/feedback`, {
					signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
				})
				if (!fbRes.ok) return null
				const data: unknown = await fbRes.json()
				return isRecord(data) && typeof data['feedback'] === 'string' ? data['feedback'] : ''
			}
		}
		return null
	} catch {
		return null
	}
}

export async function consumeFeedback(sessionId: string): Promise<string | null> {
	try {
		const res = await fetch(`${BASE_URL}/api/session/${sessionId}/feedback/consume`, {
			method: 'POST',
			signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
		})
		const data: unknown = await res.json()
		if (!isRecord(data) || data['found'] !== true) return null
		return typeof data['feedback'] === 'string' ? data['feedback'] : ''
	} catch {
		return null
	}
}

export interface BuildEvent {
	issue?: string
	status: string
	message?: string
	ts?: number
}

export async function postBuildEvent(event: BuildEvent): Promise<boolean> {
	try {
		const res = await fetch(`${BASE_URL}/api/build/event`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
		})
		return res.ok
	} catch {
		return false
	}
}

export function waitForFeedback(sessionId: string, timeoutMs: number = TIMEOUT_MS): Promise<string> {
	return new Promise((resolveP, rejectP) => {
		let settled = false
		const ws = new WebSocket(`${WS_URL}/ws/wait/${sessionId}`)

		const timer = setTimeout(() => {
			if (settled) return
			settled = true
			try {
				ws.close()
			} catch {}
			rejectP(new Error('timeout'))
		}, timeoutMs)

		ws.onmessage = (event: MessageEvent) => {
			try {
				const raw = typeof event.data === 'string' ? event.data : ''
				const data: unknown = JSON.parse(raw)
				if (isRecord(data) && data['type'] === 'submit') {
					if (settled) return
					settled = true
					clearTimeout(timer)
					try {
						ws.close()
					} catch {}
					resolveP(typeof data['feedback'] === 'string' ? data['feedback'] : '')
				}
			} catch {
			}
		}

		ws.onerror = () => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			rejectP(new Error('connection-failed'))
		}

		ws.onclose = () => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			rejectP(new Error('closed'))
		}
	})
}
