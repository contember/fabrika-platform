import type { PhaseId } from '../../../shared/phases'

export type { PhaseId } from '../../../shared/phases'

export interface PhaseState {
	current: PhaseId
	index: number
	completed: PhaseId[]
	reads: string[]
	produces: string[]
	gate: boolean
	satisfied: boolean
	gateName?: string | null
}

export interface CanvasFileInfo {
	filename: string
	label?: string
	diffStats?: { added: number; removed: number }
}

export type CanvasScope =
	| { kind: 'view'; filename: string }
	| { kind: 'directory' }

export interface RevisionMeta {
	revision: number
	label?: string | null
	canvasFiles: CanvasFileInfo[]
	hasFeedback?: boolean
	feedbackConsumed?: boolean
	createdAt?: string
	canvasScope?: CanvasScope
}

export interface SessionMeta {
	id: string
	projectRoot?: string
	currentRevision: number
	canvasFiles: CanvasFileInfo[]
	revisions: RevisionMeta[]
	gate?: string | null
	label?: string
}

export interface BuildEvent {
	issue?: string
	status: 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'info'
	message?: string
	at?: string
	data?: Record<string, unknown>
}

export interface Skeleton {
	file: string
	name: string
	url?: string
	feature?: string
	seeds: string[]
	roles: string[]
	steps: number
	invariants: number
	pending: number
}

export type WSMessage =
	| { type: 'plan-updated'; currentRevision: number; canvasFiles?: (string | CanvasFileInfo)[]; gate?: string | null }
	| { type: 'revision-updated'; currentRevision: number }
	| { type: 'watcher-status'; watching: boolean }
	| { type: 'phase-updated' }
	| { type: 'submit-ack'; revision: number }

export interface GateSubmit {
	type: 'submit'
	feedback: string
}

export type ConnStatus = 'connecting' | 'live' | 'offline' | 'fixture'
