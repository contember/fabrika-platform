import { parseArgs } from 'util'
import { z } from 'zod'
import { cliAuthHeaders } from '../cli-auth.ts'
import { BASE_URL } from '../config.ts'
import { ensureDaemon } from '../daemon-lifecycle.ts'
import { getSessionId } from '../helpers.ts'

const USAGE = 'Usage: agent-canvas reply <annotation-id> "<text>" [--resolve] [--session <id>]'

const replyResponseSchema = z.union([
	z.object({ thread: z.object({ id: z.string(), state: z.string() }) }),
	z.object({ error: z.string() }),
])

/** Answers one submitted annotation; the user sees the reply under it in the sidebar. */
export async function handleReply(args: string[]) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			session: { type: 'string' },
			resolve: { type: 'boolean', default: false },
		},
	})
	const [annotationId, ...words] = positionals
	const body = words.join(' ').trim()
	if (annotationId === undefined || body === '') {
		console.error(USAGE)
		process.exit(1)
	}

	const sessionId = getSessionId(values.session)
	await ensureDaemon()
	const res = await fetch(`${BASE_URL}/api/session/${sessionId}/threads/${encodeURIComponent(annotationId)}/reply`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...cliAuthHeaders() },
		body: JSON.stringify({ body, resolve: values.resolve }),
	})
	const data = replyResponseSchema.parse(await res.json())
	if ('error' in data) {
		console.error(`Error: ${data.error}`)
		process.exit(1)
	}
	console.log(`Replied to ${data.thread.id}; the thread is ${data.thread.state === 'resolved' ? 'resolved' : 'back with the user'}.`)
}
