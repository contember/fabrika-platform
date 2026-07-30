export function buildSentryEnvelope(options: {
	type: string
	value: string
	frames: {
		function: string
		module: string
		inApp: boolean
		filename?: string
		line?: number
		column?: number
	}[]
	release?: string
	environment?: string
	eventId?: string
	fingerprint?: string[]
}): string {
	const eventId = (options.eventId ?? crypto.randomUUID().replaceAll('-', '')).slice(0, 32)
	const header = JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() })
	const itemHeader = JSON.stringify({ type: 'event' })
	const frames = options.frames.map((frame) => ({
		function: frame.function,
		module: frame.module,
		in_app: frame.inApp,
		filename: frame.filename,
		lineno: frame.line,
		colno: frame.column,
	}))
	const payload = JSON.stringify({
		event_id: eventId,
		level: 'error',
		platform: 'javascript',
		release: options.release ?? 'v1.2.3',
		environment: options.environment ?? 'production',
		fingerprint: options.fingerprint,
		exception: {
			values: [{ type: options.type, value: options.value, stacktrace: { frames } }],
		},
	})
	return `${header}\n${itemHeader}\n${payload}\n`
}
