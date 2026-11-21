import { parseArgs } from 'node:util'
import { resolveContext } from '../context'
import { requestDashboardLink } from '../daemon-client'
import { ensureDaemon, openDashboardLink } from '../daemon-lifecycle'
import { BuilderCliError } from '../errors'

/**
 * Prints, and opens unless `--no-open`, a fresh link that signs one browser in to the session's dashboard. A browser
 * without the dashboard's cookie (another browser, a cleared one) gets a page that names this command.
 */
export async function cmdDashboard(argv: string[]): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: {
			dir: { type: 'string' },
			session: { type: 'string' },
			'no-open': { type: 'boolean' },
		},
		strict: true,
	})
	const ctx = resolveContext({ dir: values.dir, session: values.session })
	if (!await ensureDaemon({ quiet: true })) throw new BuilderCliError('Local builder daemon is unavailable.')
	const browserUrl = await requestDashboardLink(ctx.sessionId)
	if (browserUrl === null) {
		// A daemon of an older release has no link route and needs none: it serves the dashboard without a credential.
		throw new BuilderCliError(
			'The running builder daemon issued no dashboard link; it predates dashboard links. Stop it (its pid is in the output of fabrika builder ensure-daemon) and retry.',
		)
	}
	if (!values['no-open']) openDashboardLink(browserUrl)
	console.log(JSON.stringify({ ok: true, sessionId: ctx.sessionId, browserUrl }))
	return 0
}
