import { parseArgs } from 'util'
import { z } from 'zod'
import { cliAuthHeaders } from '../cli-auth.ts'
import { BASE_URL } from '../config.ts'
import { ensureDaemon } from '../daemon-lifecycle.ts'
import { getSessionId, openBrowser } from '../helpers.ts'

const linkResponseSchema = z.union([z.object({ browserUrl: z.string() }), z.object({ error: z.string() })])

/** Prints and opens a fresh link to a session's canvas: each link sets the browser's credential once. */
export async function handleOpen(args: string[]) {
	const { values } = parseArgs({
		args,
		options: {
			session: { type: 'string' },
			'no-open': { type: 'boolean', default: false },
		},
	})
	const sessionId = getSessionId(values.session)
	await ensureDaemon()
	const response = await fetch(`${BASE_URL}/api/session/${encodeURIComponent(sessionId)}/link`, { method: 'POST', headers: cliAuthHeaders() })
	const result = linkResponseSchema.parse(await response.json())
	if ('error' in result) {
		console.error(`Error: ${result.error}`)
		process.exit(1)
	}
	console.log(result.browserUrl)
	if (!values['no-open']) openBrowser(result.browserUrl)
}
