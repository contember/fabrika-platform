import {
	artifactResponseSchema,
	buildEventSchema,
	canvasFilesSchema,
	responsesEnvelopeSchema,
	sessionMetaSchema,
	sessionsSchema,
	skeletonsSchema,
	uiHealthSchema,
	uiPhaseStateSchema,
	wsMessageSchema,
} from '../../../shared'
import type { BuildEvent, CanvasFileInfo, PhaseState, SessionMeta, Skeleton, WSMessage } from './types'

export function normCanvasFiles(raw: unknown): CanvasFileInfo[] {
	return canvasFilesSchema.parse(raw)
}

function daemonOrigin(): string {
	return location.origin
}

export function sessionIdFromPath(): string | null {
	const m = location.pathname.match(/\/s\/([^/]+)/)
	return m?.[1] ?? null
}

function fabrikaRoot(): string | null {
	return new URLSearchParams(location.search).get('root')
}

async function getJson(path: string): Promise<unknown> {
	const res = await fetch(daemonOrigin() + path, { headers: { accept: 'application/json' } })
	if (!res.ok) throw new Error(`${path} -> ${res.status}`)
	return res.json()
}

export const daemon = {
	async health(): Promise<{ ok: boolean; version?: string; sessions?: string[] }> {
		const result = uiHealthSchema.safeParse(await getJson('/health'))
		if (!result.success) throw new Error('Invalid health response')
		return result.data
	},

	async phase(root?: string): Promise<PhaseState> {
		const r = root ?? fabrikaRoot()
		const sid = sessionIdFromPath()
		const params = new URLSearchParams()
		if (r) params.set('root', r)
		if (sid) params.set('session', sid)
		const qs = params.toString()
		const result = uiPhaseStateSchema.safeParse(await getJson(`/api/phase${qs ? `?${qs}` : ''}`))
		if (!result.success) throw new Error('Invalid phase response')
		return result.data
	},

	async meta(id: string): Promise<SessionMeta> {
		const result = sessionMetaSchema.safeParse(await getJson(`/api/session/${encodeURIComponent(id)}/meta`))
		if (!result.success) throw new Error('Invalid session response')
		return { id, ...result.data }
	},

	async artifact(id: string, path: string): Promise<string | null> {
		try {
			const res = await fetch(
				`${daemonOrigin()}/api/session/${encodeURIComponent(id)}/artifact?path=${encodeURIComponent(path)}`,
				{ headers: { accept: 'application/json' } },
			)
			if (!res.ok) return null
			const result = artifactResponseSchema.safeParse(await res.json())
			return result.success ? result.data.content : null
		} catch {
			return null
		}
	},

	async sessions(): Promise<{ id: string; label?: string }[]> {
		return sessionsSchema.parse(await getJson('/api/sessions'))
	},

	canvasUrl(id: string, filename: string, rev?: number): string {
		const q = rev != null ? `?rev=${rev}` : ''
		return `${daemonOrigin()}/api/session/${encodeURIComponent(id)}/canvas/${encodeURIComponent(filename)}${q}`
	},

	async skeletons(id: string): Promise<Skeleton[]> {
		const result = skeletonsSchema.safeParse(await getJson(`/api/session/${encodeURIComponent(id)}/skeletons`))
		return result.success ? result.data.skeletons : []
	},

	async feedback(id: string, rev: number): Promise<string> {
		const res = await fetch(`${daemonOrigin()}/api/session/${encodeURIComponent(id)}/revision/${rev}/feedback`)
		if (!res.ok) throw new Error(`feedback -> ${res.status}`)
		return res.text()
	},

	async getResponses<T>(id: string, rev: number, parse: (value: unknown) => T | null): Promise<T | null> {
		try {
			const result = responsesEnvelopeSchema.safeParse(await getJson(`/api/session/${encodeURIComponent(id)}/revision/${rev}/responses`))
			return result.success ? parse(result.data.responses) : null
		} catch {
			return null
		}
	},

	async saveResponses(id: string, rev: number, payload: unknown): Promise<void> {
		try {
			await fetch(`${daemonOrigin()}/api/session/${encodeURIComponent(id)}/revision/${rev}/responses`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
			})
		} catch {}
	},

	openSocket(id: string, onMessage: (m: WSMessage) => void): WebSocket {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
		const host = daemonOrigin().replace(/^https?:/, proto)
		const ws = new WebSocket(`${host}/ws/session/${encodeURIComponent(id)}`)
		ws.onmessage = (ev) => {
			try {
				const result = wsMessageSchema.safeParse(JSON.parse(String(ev.data)))
				if (result.success) onMessage(result.data)
			} catch {}
		}
		return ws
	},

	submitGate(ws: WebSocket, feedback: string): boolean {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: 'submit', feedback }))
			return true
		}
		return false
	},

	buildStream(onEvent: (e: BuildEvent) => void): EventSource | null {
		try {
			const es = new EventSource(`${daemonOrigin()}/api/build/stream`)
			es.onmessage = (ev) => {
				try {
					const result = buildEventSchema.safeParse(JSON.parse(ev.data))
					if (result.success) onEvent(result.data)
				} catch {}
			}
			return es
		} catch {
			return null
		}
	},
}
