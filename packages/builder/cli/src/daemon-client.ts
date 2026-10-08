import { waitForEvent } from '@fabrika/daemon-kit'
import {
	consumedFeedbackSchema,
	feedbackMetaSchema,
	feedbackTextSchema,
	phaseStateSchema,
	planResultSchema,
	submitFeedbackSchema,
} from '../../shared'
import { BASE_URL, TIMEOUT_MS, WS_URL } from './config'
import type { PhaseState } from './derive'

const HEALTH_TIMEOUT_MS = 1000

export async function fetchPhase(fabrikaDir: string, sessionId?: string): Promise<PhaseState | null> {
	try {
		let url = `${BASE_URL}/api/phase?root=${encodeURIComponent(fabrikaDir)}`
		if (sessionId) url += `&session=${encodeURIComponent(sessionId)}`
		const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
		if (!res.ok) return null
		const result = phaseStateSchema.safeParse(await res.json())
		return result.success ? result.data : null
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
		const result = planResultSchema.safeParse(await res.json())
		return { ...(result.success ? result.data : { ok: false, error: 'Invalid daemon response' }), reachable: true }
	} catch (e) {
		return { ok: false, reachable: false, error: String(e) }
	}
}

export async function peekFeedback(sessionId: string): Promise<string | null> {
	try {
		const metaRes = await fetch(`${BASE_URL}/api/session/${sessionId}/meta`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
		if (!metaRes.ok) return null
		const meta = feedbackMetaSchema.safeParse(await metaRes.json())
		if (!meta.success) return null
		const revisions = meta.data.revisions
		for (let i = revisions.length - 1; i >= 0; i--) {
			const revision = revisions[i]!
			if (revision.hasFeedback && !revision.feedbackConsumed) {
				const fbRes = await fetch(`${BASE_URL}/api/session/${sessionId}/revision/${revision.revision}/feedback`, {
					signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
				})
				if (!fbRes.ok) return null
				const result = feedbackTextSchema.safeParse(await fbRes.json())
				return result.success ? result.data.feedback : ''
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
		const result = consumedFeedbackSchema.safeParse(await res.json())
		return result.success ? result.data.feedback : null
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
	return waitForEvent({
		url: `${WS_URL}/ws/wait/${sessionId}`,
		timeoutMs,
		onFrame: (frame) => {
			const result = submitFeedbackSchema.safeParse(frame)
			return result.success ? { type: 'settle', value: result.data.feedback } : undefined
		},
		probe: async () => {
			const feedback = await peekFeedback(sessionId)
			return feedback === null ? undefined : { value: feedback }
		},
	})
}
