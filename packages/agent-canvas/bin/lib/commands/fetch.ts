import { parseArgs } from 'util'
import { ensureDaemon } from '../daemon-lifecycle.ts'
import { getSessionId, pendingInput } from '../helpers.ts'

export async function handleFetch(args: string[]) {
	const { values } = parseArgs({
		args,
		options: {
			session: { type: 'string' },
		},
	})

	const sessionId = getSessionId(values.session)
	await ensureDaemon()

	const pending = await pendingInput(sessionId)
	if (pending) {
		process.stdout.write(pending)
	}
}
