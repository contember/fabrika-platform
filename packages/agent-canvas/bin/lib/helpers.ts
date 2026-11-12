import { WaitError, type WaiterSocket, waitForEvent, type WaitVerdict } from '@fabrika/daemon-kit'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { cliAuthHeaders, cliSocketUrl } from './cli-auth.ts'
import { BASE_URL, TIMEOUT_MS, WS_URL } from './config.ts'

export function getSessionId(session?: string): string {
	if (session) return session
	return process.env.CANVAS_SESSION_ID || (() => {
		const id = randomUUID()
		console.error(`Warning: CANVAS_SESSION_ID not set, using generated ID: ${id}`)
		return id
	})()
}

const consumeResponseSchema = z.discriminatedUnion('found', [
	z.object({ found: z.literal(true), feedback: z.string() }),
	z.object({ found: z.literal(false) }),
])

export async function consumeFeedback(sessionId: string): Promise<string | null> {
	const res = await fetch(`${BASE_URL}/api/session/${sessionId}/feedback/consume`, { method: 'POST', headers: cliAuthHeaders() })
	const data = consumeResponseSchema.parse(await res.json())
	if (data.found) return data.feedback
	return null
}

const claimResponseSchema = z.object({ markdown: z.string().nullable() })

/** The thread replies the user sent since the last claim, as markdown; each is handed over once. */
export async function claimThreadReplies(sessionId: string): Promise<string | null> {
	const res = await fetch(`${BASE_URL}/api/session/${sessionId}/threads/claim`, { method: 'POST', headers: cliAuthHeaders() })
	if (!res.ok) throw new Error(`Claiming thread replies failed with status ${res.status}`)
	return claimResponseSchema.parse(await res.json()).markdown
}

/** What the user sent and the agent has not read yet: a submit first, then thread replies. */
export async function pendingInput(sessionId: string): Promise<string | null> {
	return (await consumeFeedback(sessionId)) ?? (await claimThreadReplies(sessionId))
}

export function openBrowser(url: string) {
	const candidates = process.platform === 'darwin'
		? ['open']
		: ['xdg-open', 'wslview', 'sensible-browser']

	for (const cmd of candidates) {
		const which = Bun.spawnSync(['which', cmd])
		if (which.exitCode === 0) {
			spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref()
			return
		}
	}
	console.error(`Open this URL in your browser: ${url}`)
}

interface FeedbackWaitOptions {
	createSocket?: (url: string) => WaiterSocket
	/** Reads input the socket only announces (a thread reply) or that arrived while it was reconnecting. */
	probe?: () => Promise<string | null>
	timeoutMs?: number
	reconnectAttempts?: number
	reconnectDelayMs?: number
}

const canvasRenderErrorSchema = z.object({
	revision: z.number().int(),
	filename: z.string(),
	message: z.string(),
	stack: z.string().optional(),
	componentStack: z.string().optional(),
})
type CanvasRenderError = z.infer<typeof canvasRenderErrorSchema>

/** What the daemon sends a waiting CLI. */
const waitFrameSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('submit'), feedback: z.string() }),
	z.object({ type: z.literal('render-error'), error: canvasRenderErrorSchema }),
	z.object({ type: z.literal('thread-queued') }),
	z.object({ type: z.literal('remote-feedback-arrived'), revision: z.number().int(), count: z.number().int(), reviewers: z.array(z.string()) }),
])
export type WaitFrame = z.infer<typeof waitFrameSchema>

/** A frame the CLI understands, or null for anything else (a keepalive, a newer daemon's frame). */
export function parseWaitFrame(frame: unknown): WaitFrame | null {
	const parsed = waitFrameSchema.safeParse(frame)
	return parsed.success ? parsed.data : null
}

export function formatCanvasRenderError(error: CanvasRenderError): string {
	const details = [`Canvas render failed in ${error.filename} (revision ${error.revision}):`, error.message]
	if (error.componentStack?.trim()) details.push(`Component stack:${error.componentStack}`)
	if (error.stack?.trim()) details.push(`Browser stack:\n${error.stack}`)
	return details.join('\n')
}

/** One handed-over input. Boxed so the wait can tell which probe settled it, whatever the text. */
interface Input {
	text: string
}

/** A canvas that failed to render is the answer — retrying the socket cannot fix it. */
function readFeedbackFrame(raw: unknown): WaitVerdict<Input> | undefined {
	const frame = parseWaitFrame(raw)
	switch (frame?.type) {
		case 'submit':
			return { type: 'settle', value: { text: frame.feedback } }
		case 'render-error':
			return { type: 'fail', error: new Error(formatCanvasRenderError(frame.error)) }
		case 'thread-queued':
			return { type: 'recheck' }
		default:
			return undefined
	}
}

type ConnectionOutcome =
	| { type: 'settled'; text: string; late: string[] }
	| { type: 'failed'; error: unknown; late: string[] }

/**
 * One connection's wait. A probe hands input over once, so one that resolves after its connection settled or
 * dropped is returned as `late` instead of being lost.
 */
async function waitOnConnection(sessionId: string, options: FeedbackWaitOptions, timeoutMs: number): Promise<ConnectionOutcome> {
	const { probe } = options
	const reads: Promise<Input | null>[] = []
	const late = async (settled: Input | null): Promise<string[]> => {
		const inputs = await Promise.all(reads.map((read) => read.catch(() => null)))
		return inputs.flatMap((input) => (input === null || input === settled ? [] : [input.text]))
	}
	try {
		const settled = await waitForEvent<Input>({
			url: `${WS_URL}/ws/wait/${sessionId}`,
			onFrame: readFeedbackFrame,
			...(probe === undefined ? {} : {
				probe: async () => {
					const read = probe().then((text) => (text === null ? null : { text }))
					reads.push(read)
					const input = await read
					return input === null ? undefined : { value: input }
				},
				alreadyProbed: true,
			}),
			createSocket: options.createSocket ?? ((url) => new WebSocket(cliSocketUrl(url))),
			timeoutMs,
			messages: {
				timeout: 'Timeout waiting for feedback.',
				closed: 'WebSocket closed before feedback was submitted.',
				connectionFailed: 'WebSocket connection failed.',
			},
		})
		return { type: 'settled', text: settled.text, late: await late(settled) }
	} catch (error) {
		return { type: 'failed', error, late: await late(null) }
	}
}

export async function waitForFeedback(sessionId: string, options: FeedbackWaitOptions = {}): Promise<string> {
	const deadline = Date.now() + (options.timeoutMs ?? TIMEOUT_MS)
	const reconnectAttempts = options.reconnectAttempts ?? 3
	const reconnectDelayMs = options.reconnectDelayMs ?? 1_000
	// Reconnects here rather than in the waiter, so input claimed on a dropped connection is seen before the next one.
	for (let attempt = 0;; attempt++) {
		const outcome = await waitOnConnection(sessionId, options, deadline - Date.now())
		if (outcome.type === 'settled') return [outcome.text, ...outcome.late].join('\n')
		const { error, late } = outcome
		const dropped = error instanceof WaitError && error.retryable
		if (dropped && late.length > 0) return late.join('\n')
		if (!dropped || attempt >= reconnectAttempts) {
			if (late.length === 0) throw error
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(`${message}\n\n${late.join('\n')}`, { cause: error })
		}
		await Bun.sleep(Math.min(reconnectDelayMs, Math.max(0, deadline - Date.now())))
	}
}

export async function readLine(): Promise<string> {
	const buf: number[] = []
	for await (const chunk of Bun.stdin.stream()) {
		for (const byte of chunk) {
			if (byte === 10) return Buffer.from(buf).toString('utf-8')
			buf.push(byte)
		}
	}
	return Buffer.from(buf).toString('utf-8')
}
