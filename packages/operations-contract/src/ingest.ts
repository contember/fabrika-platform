/** Browser- and runtime-safe shapes at the direct Sentry-compatible ingest boundary. */

export interface StackFrame {
	function?: string
	filename?: string
	module?: string
	absPath?: string
	line?: number
	column?: number
	inApp?: boolean
	preContext?: string[]
	contextLine?: string
	postContext?: string[]
}

export interface ParsedException {
	type: string
	value: string
	frames: StackFrame[]
}

export interface ParsedEvent {
	eventId: string
	projectId: string
	exception: ParsedException
	level: string
	release?: string
	environment?: string
	platform?: string
	tags: Record<string, string>
	sdkFingerprint: string[] | null
	receivedAt: number
	raw: Record<string, unknown>
}

export interface IngestMessage {
	projectId: string
	fingerprint: string
	eventId: string
	title: string
	culprit: string | null
	level: string
	release?: string
	environment?: string
	receivedAt: number
	payload: Record<string, unknown>
}

export type IngestRejectReason = 'unauthorized' | 'forbidden' | 'too_large' | 'malformed' | 'unavailable'
