import { parseArgs } from 'node:util'
import { parseBuilderOrigin, parseBuilderPreviewUrl } from '../../../shared'
import { BASE_URL } from '../config'
import { resolveContext } from '../context'
import { ensureDaemon, openBrowser } from '../daemon-lifecycle'
import { BuilderCliError } from '../errors'
import { readConfig } from '../layout'
import { platformRequest, publicPlatformStatus } from '../platform-client'

export type PlatformCommand = 'connect' | 'status' | 'disconnect' | 'deploy' | 'preview'
const stringOption: { type: 'string' } = { type: 'string' }
const booleanOption: { type: 'boolean' } = { type: 'boolean' }

export async function cmdPlatform(command: PlatformCommand, argv: string[]): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: {
			json: { type: 'boolean' },
			dir: { type: 'string' },
			...(command === 'connect' || command === 'preview' ? { url: stringOption } : {}),
			...(command === 'connect' ? { 'no-open': booleanOption } : {}),
			...(command === 'preview' ? { clear: booleanOption } : {}),
			...(command === 'deploy' ? { wait: booleanOption, timeout: stringOption } : {}),
		},
	})
	const origin = command === 'connect' ? parseBuilderOrigin(values.url, 'control origin') : undefined
	if (command === 'preview' && Boolean(values.clear) === (values.url !== undefined)) {
		throw new BuilderCliError('Use preview --url=<url> or preview --clear.')
	}
	const previewUrl = command === 'preview' && !values.clear ? parseBuilderPreviewUrl(values.url) : null
	const seconds = values.timeout === undefined ? 600 : Number(values.timeout)
	if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new Error('Timeout must be between 0 and 86400 seconds (exclusive of 0).')
	if (values.timeout !== undefined && !values.wait) throw new Error('--timeout requires --wait.')
	const ctx = resolveContext({ dir: values.dir })
	const config = readConfig(ctx.repoRoot)
	if (!config) throw new BuilderCliError('Run fabrika builder init first.')
	if (
		(command === 'connect' || command === 'deploy')
		&& (config.profile !== 'zerops-app' || (config.connection && config.connection.receipt.provider !== 'zerops'))
	) {
		throw new BuilderCliError('Connected deployment requires the zerops-app profile.')
	}
	if (!await ensureDaemon({ quiet: true })) throw new BuilderCliError('Local builder daemon is unavailable.')
	await platformRequest(config.sessionId, 'register', { projectRoot: ctx.repoRoot })
	const dashboardUrl = `${BASE_URL}/s/${encodeURIComponent(config.sessionId)}`
	let status = await platformRequest(
		config.sessionId,
		command === 'status' ? 'platform' : command,
		command === 'status' ? undefined : command === 'connect' ? { controlOrigin: origin } : command === 'preview' ? { url: previewUrl } : {},
	)
	if (command === 'connect' && status.pairing?.status === 'pending' && !values['no-open']) {
		openBrowser(status.pairing.authorizationUrl, dashboardUrl)
	}
	if (command === 'disconnect') console.error('Local credentials removed. Revoke the authorization in the platform console to revoke server access.')
	let outcome: string | undefined
	if (command === 'deploy' && values.wait) {
		const deadline = Date.now() + seconds * 1000
		while (status.deployment && ['preparing', 'pending', 'running'].includes(status.deployment.status)) {
			if (Date.now() >= deadline) {
				outcome = 'timed_out'
				break
			}
			await Bun.sleep(Math.min(1000, deadline - Date.now()))
			if (Date.now() >= deadline) {
				outcome = 'timed_out'
				break
			}
			try {
				status = await platformRequest(config.sessionId, 'platform', undefined, Math.max(1, Math.ceil(deadline - Date.now())))
			} catch {
				outcome = Date.now() >= deadline ? 'timed_out' : 'poll_failed'
				break
			}
		}
		outcome ??= status.deployment?.status ?? 'missing_run'
	}
	console.log(JSON.stringify({ ...publicPlatformStatus(status), dashboardUrl, ...(outcome ? { outcome } : {}) }))
	if (command === 'connect' && status.pairing && ['failed', 'expired', 'cancelled', 'recovery_required'].includes(status.pairing.status)) return 1
	if (command === 'deploy' && status.deployment && ['failed', 'cancelled'].includes(status.deployment.status)) return 1
	return outcome !== undefined && outcome !== 'succeeded' ? 1 : 0
}
