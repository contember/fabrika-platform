import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { type BuilderPlatformStatus, parseBuilderOrigin } from '../../../shared'
import { BASE_URL, SESSIONS_DIR } from '../config'
import { ensureDaemon, openBrowser } from '../daemon-lifecycle'
import { BuilderCliError } from '../errors'
import { type AgentHost, injectAgentSupport, parseAgentHosts } from '../inject-skills'
import { readConfig, scaffold } from '../layout'
import { platformRequest, publicPlatformStatus } from '../platform-client'

async function resetStaleSession(sessionId: string): Promise<void> {
	try {
		await fetch(`${BASE_URL}/api/session/${encodeURIComponent(sessionId)}/reset`, { method: 'POST' })
	} catch {
	}
	try {
		rmSync(join(SESSIONS_DIR, sessionId), { recursive: true, force: true })
	} catch {
	}
}

export async function cmdInit(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			profile: { type: 'string' },
			url: { type: 'string' },
			json: { type: 'boolean' },
			session: { type: 'string' },
			agent: { type: 'string', default: 'all' },
			'no-daemon': { type: 'boolean', default: false },
			'no-open': { type: 'boolean', default: false },
		},
		allowPositionals: true,
	})

	let hosts: AgentHost[]
	try {
		hosts = parseAgentHosts(values.agent)
	} catch (error: unknown) {
		console.error(`[fabrika] ${error instanceof Error ? error.message : String(error)}`)
		return 1
	}
	const dir = positionals[0] ?? process.cwd()
	if (positionals.length > 1) throw new Error('Expected at most one project directory.')
	const origin = values.url === undefined ? undefined : parseBuilderOrigin(values.url, 'control origin')
	if (origin && values['no-daemon']) throw new BuilderCliError('--url cannot be combined with --no-daemon.')
	const existing = readConfig(dir)
	const profile = values.profile ?? existing?.profile ?? (origin ? 'zerops-app' : 'cf-lightweight')
	if (existing && (profile !== existing.profile || (values.session && values.session !== existing.sessionId))) {
		throw new BuilderCliError('Existing project profile and session cannot be replaced by init.')
	}
	if (origin && (profile !== 'zerops-app' || (existing?.connection && existing.connection.receipt.provider !== 'zerops'))) {
		throw new BuilderCliError('Connected initialization requires zerops-app.')
	}
	if (origin && existing?.connection && existing.connection.controlOrigin !== origin) {
		throw new BuilderCliError('Disconnect explicitly before changing installations.')
	}
	const result = scaffold(dir, { profile, sessionId: values.session })
	const support = injectAgentSupport(result.repoRoot, { hosts })

	if (result.alreadyInitialized) {
		console.error(`[fabrika] .fabrika/ already initialized at ${result.fabrikaDir} (idempotent re-run)`)
	} else {
		console.error(`[fabrika] scaffolded .fabrika/ at ${result.fabrikaDir}`)
	}
	if (result.createdDirs.length) {
		console.error(`[fabrika] created ${result.createdDirs.length} dir(s)`)
	}
	if (support.sourceDir) {
		console.error(
			`[fabrika] agent support (${support.hosts.join('+')}): `
				+ `${support.written.length} installed, ${support.updated.length} updated, `
				+ `${support.skipped.length} current, ${support.preserved.length} user-edited preserved`,
		)
	} else {
		console.error(`[fabrika] agent support: source dir not found, skipped installation`)
	}

	const browserUrl = `${BASE_URL}/s/${result.config.sessionId}`
	let platform: BuilderPlatformStatus | undefined
	if (!values['no-daemon']) {
		const up = await ensureDaemon({ quiet: true })
		if (!result.alreadyInitialized) {
			await resetStaleSession(result.config.sessionId)
			console.error(`[fabrika] cleared any stale session for ${result.config.sessionId}`)
		}
		if (up) {
			platform = await platformRequest(result.config.sessionId, 'register', { projectRoot: result.repoRoot })
			if (origin) {
				const pinnedOrigin = platform.connection?.controlOrigin
					?? (platform.pairing?.status === 'pending' ? new URL(platform.pairing.authorizationUrl).origin : undefined)
				if (pinnedOrigin && pinnedOrigin !== origin) throw new BuilderCliError('Disconnect explicitly before changing installations.')
				if (!existing?.connection && !platform.connection && platform.pairing?.status !== 'pending' && platform.pairing?.status !== 'approved') {
					platform = await platformRequest(result.config.sessionId, 'connect', { controlOrigin: origin })
				}
			}
		} else if (origin) {
			throw new Error('Local builder daemon is unavailable.')
		}
		if (up && !values['no-open'] && platform?.pairing?.status === 'pending') {
			openBrowser(platform.pairing.authorizationUrl, browserUrl)
		} else if (up && !values['no-open']) {
			openBrowser(browserUrl)
		} else if (!up) {
			console.error(`[fabrika] daemon not started (offline). Dashboard: ${browserUrl}`)
		}
	} else if (!result.alreadyInitialized) {
		await resetStaleSession(result.config.sessionId)
	}

	console.log(
		JSON.stringify({
			ok: true,
			repoRoot: result.repoRoot,
			fabrikaDir: result.fabrikaDir,
			sessionId: result.config.sessionId,
			profile: result.config.profile,
			agents: support.hosts,
			browserUrl,
			createdConfig: result.createdConfig,
			...(platform ? { platform: publicPlatformStatus(platform) } : {}),
		}),
	)
	if (origin && platform?.pairing && ['failed', 'expired', 'cancelled', 'recovery_required'].includes(platform.pairing.status)) return 1
	return 0
}
