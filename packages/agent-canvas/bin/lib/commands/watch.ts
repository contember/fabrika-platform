import { parseArgs } from 'util'
import { cliSocketUrl } from '../cli-auth.ts'
import { WS_URL } from '../config.ts'
import { ensureDaemon } from '../daemon-lifecycle.ts'
import {
	claimThreadReplies,
	consumeFeedback,
	formatCanvasRenderError,
	getSessionId,
	parseWaitFrame,
	pendingInput,
	waitForFeedback,
} from '../helpers.ts'

export async function handleWatch(args: string[]) {
	const { values } = parseArgs({
		args,
		options: {
			session: { type: 'string' },
			follow: { type: 'boolean', default: false },
		},
	})

	const sessionId = getSessionId(values.session)
	await ensureDaemon()
	if (values.follow) return followSession(sessionId)

	const pending = await pendingInput(sessionId)
	if (pending) {
		process.stdout.write(pending)
		process.exit(0)
	}

	try {
		const submittedFeedback = await waitForFeedback(sessionId, { probe: () => pendingInput(sessionId) })
		process.stdout.write(submittedFeedback)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(`Error: ${message}`)
		process.exit(1)
	}
}

const RECONNECT_MS = 2_000
const GIVE_UP_MS = 60_000
const MAX_NAME = 40

/** A name a reviewer typed, as a quoted label that cannot pass for anything else in the agent's output. */
export function reviewerLabel(name: string): string {
	return JSON.stringify(name.replace(/\p{Cc}/gu, ' ').trim().slice(0, MAX_NAME))
}

function emit(event: string, body: string): void {
	process.stdout.write(`[agent-canvas ${event}]\n${body.trimEnd()}\n\n`)
}

/**
 * The streaming watcher for hosts that turn each output line into an event (Claude Code's Monitor): one block per
 * submit, thread reply, render error or remote-feedback arrival. Status goes to stderr, so every stdout block is
 * worth acting on. A submit ends the daemon's wait, so the socket reconnects after each one.
 */
function followSession(sessionId: string): Promise<never> {
	let draining = Promise.resolve()
	let unreachableSince: number | null = null

	// Reads what the socket only announces, or what arrived while it was reconnecting; each is handed over once.
	const drain = () => {
		draining = draining.then(async () => {
			const feedback = await consumeFeedback(sessionId)
			if (feedback) emit('submit', feedback)
			const replies = await claimThreadReplies(sessionId)
			if (replies) emit('thread-reply', replies)
		}).catch((error: unknown) => {
			console.error(`watch: ${error instanceof Error ? error.message : String(error)}`)
		})
	}

	const onFrame = (raw: unknown) => {
		if (typeof raw !== 'string') return
		let json: unknown
		try {
			json = JSON.parse(raw)
		} catch {
			return
		}
		const frame = parseWaitFrame(json)
		switch (frame?.type) {
			case 'submit':
				return emit('submit', frame.feedback)
			case 'render-error':
				return emit('render-error', formatCanvasRenderError(frame.error))
			case 'thread-queued':
				return drain()
			case 'remote-feedback-arrived':
				return emit(
					'remote-feedback-arrived',
					`${frame.count} comment(s) on revision ${frame.revision} from reviewer(s) ${frame.reviewers.map(reviewerLabel).join(', ')}`
						+ ' (names as they typed them). Their text reaches you only when the user includes it in a submit.',
				)
			default:
				return
		}
	}

	const connect = () => {
		const socket = new WebSocket(cliSocketUrl(`${WS_URL}/ws/wait/${sessionId}`))
		socket.onopen = () => {
			unreachableSince = null
			console.error(`watch: following session ${sessionId}`)
			drain()
		}
		socket.onmessage = (event) => onFrame(event.data)
		socket.onclose = () => {
			unreachableSince ??= Date.now()
			if (Date.now() - unreachableSince > GIVE_UP_MS) {
				console.log(`[agent-canvas stopped]\nThe daemon has been unreachable for a minute; stopped following session ${sessionId}.`)
				process.exit(1)
			}
			setTimeout(connect, RECONNECT_MS)
		}
	}

	connect()
	return new Promise<never>(() => {})
}
