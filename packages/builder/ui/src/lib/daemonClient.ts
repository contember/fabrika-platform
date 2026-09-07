import type { BuildEvent, CanvasFileInfo, CanvasScope, PhaseState, RevisionMeta, SessionMeta, Skeleton, WSMessage } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPresent<T>(value: T | null): value is T {
	return value !== null
}

function stringArray(value: unknown): string[] | null {
	if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string')) return null
	return value
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}

function parseDiffStats(value: unknown): CanvasFileInfo['diffStats'] {
	if (!isRecord(value) || typeof value['added'] !== 'number' || typeof value['removed'] !== 'number') return undefined
	return { added: value['added'], removed: value['removed'] }
}

export function normCanvasFiles(raw: unknown): CanvasFileInfo[] {
	if (!Array.isArray(raw)) return []
	return raw
		.map((x): CanvasFileInfo | null => {
			if (typeof x === 'string') return { filename: x }
			if (!isRecord(x) || typeof x['filename'] !== 'string') return null
			const label = optionalString(x['label'])
			const diffStats = parseDiffStats(x['diffStats'])
			return {
				filename: x['filename'],
				...(label === undefined ? {} : { label }),
				...(diffStats === undefined ? {} : { diffStats }),
			}
		})
		.filter(isPresent)
		.filter((canvas) => canvas.filename.length > 0)
}

function normRevisions(raw: unknown): RevisionMeta[] {
	if (!Array.isArray(raw)) return []
	return raw
		.map((revision): RevisionMeta | null => {
			if (!isRecord(revision) || typeof revision['revision'] !== 'number') return null
			const scopeRaw = revision['canvasScope']
			let canvasScope: CanvasScope | undefined
			if (isRecord(scopeRaw) && scopeRaw['kind'] === 'directory') {
				canvasScope = { kind: 'directory' }
			} else if (isRecord(scopeRaw) && scopeRaw['kind'] === 'view' && typeof scopeRaw['filename'] === 'string') {
				canvasScope = { kind: 'view', filename: scopeRaw['filename'] }
			}
			const label = optionalString(revision['label'])
			const createdAt = optionalString(revision['createdAt'])
			return {
				revision: revision['revision'],
				label: label ?? null,
				canvasFiles: normCanvasFiles(revision['canvasFiles']),
				hasFeedback: revision['hasFeedback'] === true,
				feedbackConsumed: revision['feedbackConsumed'] === true,
				...(createdAt === undefined ? {} : { createdAt }),
				...(canvasScope === undefined ? {} : { canvasScope }),
			}
		})
		.filter(isPresent)
		.filter((revision) => revision.revision > 0)
}

const PHASE_IDS: PhaseState['current'][] = ['intake', 'vision', 'flows', 'tech', 'design', 'skeletons', 'issues', 'build']

function isPhaseId(value: unknown): value is PhaseState['current'] {
	return typeof value === 'string' && PHASE_IDS.some((phase) => phase === value)
}

function parsePhaseState(value: unknown): PhaseState {
	if (!isRecord(value) || !isPhaseId(value['current']) || typeof value['index'] !== 'number') {
		throw new Error('Invalid phase response')
	}
	const rawCompleted = value['completed']
	const completed = Array.isArray(rawCompleted) ? rawCompleted.filter(isPhaseId) : []
	const reads = stringArray(value['reads'])
	const produces = stringArray(value['produces'])
	if (!Array.isArray(rawCompleted) || completed.length !== rawCompleted.length || reads === null || produces === null) {
		throw new Error('Invalid phase response')
	}
	if (typeof value['gate'] !== 'boolean' || typeof value['satisfied'] !== 'boolean') {
		throw new Error('Invalid phase response')
	}
	const gateName = value['gateName'] === null ? null : optionalString(value['gateName'])
	return {
		current: value['current'],
		index: value['index'],
		completed,
		reads,
		produces,
		gate: value['gate'],
		satisfied: value['satisfied'],
		...(gateName === undefined ? {} : { gateName }),
	}
}

function parseSession(value: unknown): { id: string; label?: string } | null {
	if (!isRecord(value) || typeof value['id'] !== 'string') return null
	const label = optionalString(value['label'])
	return { id: value['id'], ...(label === undefined ? {} : { label }) }
}

function parseSkeleton(value: unknown): Skeleton | null {
	if (!isRecord(value) || typeof value['file'] !== 'string' || typeof value['name'] !== 'string') return null
	const seeds = stringArray(value['seeds'])
	const roles = stringArray(value['roles'])
	if (seeds === null || roles === null || typeof value['steps'] !== 'number' || typeof value['invariants'] !== 'number') return null
	if (typeof value['pending'] !== 'number') return null
	const url = optionalString(value['url'])
	const feature = optionalString(value['feature'])
	return {
		file: value['file'],
		name: value['name'],
		seeds,
		roles,
		steps: value['steps'],
		invariants: value['invariants'],
		pending: value['pending'],
		...(url === undefined ? {} : { url }),
		...(feature === undefined ? {} : { feature }),
	}
}

function parseWSMessage(value: unknown): WSMessage | null {
	if (!isRecord(value) || typeof value['type'] !== 'string') return null
	switch (value['type']) {
		case 'plan-updated': {
			if (typeof value['currentRevision'] !== 'number') return null
			const canvasFiles = Array.isArray(value['canvasFiles']) ? value['canvasFiles'] : undefined
			const gate = value['gate'] === null ? null : optionalString(value['gate'])
			return {
				type: 'plan-updated',
				currentRevision: value['currentRevision'],
				...(canvasFiles === undefined ? {} : { canvasFiles: normCanvasFiles(canvasFiles) }),
				...(gate === undefined ? {} : { gate }),
			}
		}
		case 'revision-updated':
			return typeof value['currentRevision'] === 'number'
				? { type: 'revision-updated', currentRevision: value['currentRevision'] }
				: null
		case 'watcher-status':
			return typeof value['watching'] === 'boolean' ? { type: 'watcher-status', watching: value['watching'] } : null
		case 'phase-updated':
			return { type: 'phase-updated' }
		case 'submit-ack':
			return typeof value['revision'] === 'number' ? { type: 'submit-ack', revision: value['revision'] } : null
		default:
			return null
	}
}

function isBuildStatus(value: unknown): value is BuildEvent['status'] {
	return value === 'queued' || value === 'running' || value === 'passed' || value === 'failed' || value === 'blocked'
		|| value === 'info'
}

function parseBuildEvent(value: unknown): BuildEvent | null {
	if (!isRecord(value) || !isBuildStatus(value['status'])) return null
	const issue = optionalString(value['issue'])
	const message = optionalString(value['message'])
	const at = optionalString(value['at'])
	const data = isRecord(value['data']) ? value['data'] : undefined
	return {
		status: value['status'],
		...(issue === undefined ? {} : { issue }),
		...(message === undefined ? {} : { message }),
		...(at === undefined ? {} : { at }),
		...(data === undefined ? {} : { data }),
	}
}

function daemonOrigin(): string {
	const override = new URLSearchParams(location.search).get('daemon')
	return override ?? location.origin
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
		const value = await getJson('/health')
		if (!isRecord(value) || value['ok'] !== true) throw new Error('Invalid health response')
		const version = optionalString(value['version'])
		const sessions = stringArray(value['sessions'])
		return { ok: true, ...(version === undefined ? {} : { version }), ...(sessions === null ? {} : { sessions }) }
	},

	async phase(root?: string): Promise<PhaseState> {
		const r = root ?? fabrikaRoot()
		const sid = sessionIdFromPath()
		const params = new URLSearchParams()
		if (r) params.set('root', r)
		if (sid) params.set('session', sid)
		const qs = params.toString()
		return parsePhaseState(await getJson(`/api/phase${qs ? `?${qs}` : ''}`))
	},

	async meta(id: string): Promise<SessionMeta> {
		const raw = await getJson(`/api/session/${encodeURIComponent(id)}/meta`)
		if (!isRecord(raw)) throw new Error('Invalid session response')
		const projectRoot = optionalString(raw['projectRoot'])
		const label = optionalString(raw['label'])
		const gate = raw['gate'] === null ? null : optionalString(raw['gate'])
		return {
			id,
			...(projectRoot === undefined ? {} : { projectRoot }),
			currentRevision: typeof raw['currentRevision'] === 'number' ? raw['currentRevision'] : 0,
			canvasFiles: normCanvasFiles(raw['canvasFiles']),
			revisions: normRevisions(raw['revisions']),
			gate: gate ?? null,
			...(label === undefined ? {} : { label }),
		}
	},

	async artifact(id: string, path: string): Promise<string | null> {
		try {
			const res = await fetch(
				`${daemonOrigin()}/api/session/${encodeURIComponent(id)}/artifact?path=${encodeURIComponent(path)}`,
				{ headers: { accept: 'application/json' } },
			)
			if (!res.ok) return null
			const data: unknown = await res.json()
			return isRecord(data) && typeof data['content'] === 'string' ? data['content'] : null
		} catch {
			return null
		}
	},

	async sessions(): Promise<{ id: string; label?: string }[]> {
		const value = await getJson('/api/sessions')
		return Array.isArray(value) ? value.map(parseSession).filter(isPresent) : []
	},

	canvasUrl(id: string, filename: string, rev?: number): string {
		const q = rev != null ? `?rev=${rev}` : ''
		return `${daemonOrigin()}/api/session/${encodeURIComponent(id)}/canvas/${encodeURIComponent(filename)}${q}`
	},

	async skeletons(id: string): Promise<Skeleton[]> {
		const data = await getJson(`/api/session/${encodeURIComponent(id)}/skeletons`)
		if (!isRecord(data) || !Array.isArray(data['skeletons'])) return []
		return data['skeletons'].map(parseSkeleton).filter(isPresent)
	},

	async feedback(id: string, rev: number): Promise<string> {
		const res = await fetch(
			`${daemonOrigin()}/api/session/${encodeURIComponent(id)}/revision/${rev}/feedback`,
		)
		if (!res.ok) throw new Error(`feedback -> ${res.status}`)
		return res.text()
	},

	async getResponses<T>(id: string, rev: number, validate: (value: unknown) => value is T): Promise<T | null> {
		try {
			const data = await getJson(`/api/session/${encodeURIComponent(id)}/revision/${rev}/responses`)
			if (!isRecord(data)) return null
			const responses = data['responses']
			return validate(responses) ? responses : null
		} catch {
			return null
		}
	},

	async saveResponses(id: string, rev: number, payload: unknown): Promise<void> {
		try {
			await fetch(
				`${daemonOrigin()}/api/session/${encodeURIComponent(id)}/revision/${rev}/responses`,
				{
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload),
				},
			)
		} catch {
		}
	},

	openSocket(id: string, onMessage: (m: WSMessage) => void): WebSocket {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
		const host = daemonOrigin().replace(/^https?:/, proto)
		const ws = new WebSocket(`${host}/ws/session/${encodeURIComponent(id)}`)
		ws.onmessage = (ev) => {
			try {
				const message = parseWSMessage(JSON.parse(String(ev.data)))
				if (message !== null) onMessage(message)
			} catch {
			}
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
					const event = parseBuildEvent(JSON.parse(ev.data))
					if (event !== null) onEvent(event)
				} catch {
				}
			}
			return es
		} catch {
			return null
		}
	},
}
