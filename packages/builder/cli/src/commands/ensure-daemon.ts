import { BASE_URL } from '../config'
import { health } from '../daemon-client'
import { ensureDaemon } from '../daemon-lifecycle'

export async function cmdEnsureDaemon(_argv: string[]): Promise<number> {
	const up = await ensureDaemon()
	if (!up) {
		console.log(JSON.stringify({ ok: false, running: false, baseUrl: BASE_URL }))
		return 1
	}
	const info = await health()
	console.log(
		JSON.stringify({
			ok: true,
			running: true,
			baseUrl: BASE_URL,
			version: info?.version ?? null,
			pid: info?.pid ?? null,
			dataDir: info?.dataDir ?? null,
			sessionsDir: info?.sessionsDir ?? null,
			sessions: info?.sessions ?? null,
		}),
	)
	return 0
}
