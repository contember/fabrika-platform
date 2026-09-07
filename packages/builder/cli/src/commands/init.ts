import { rmSync } from 'fs'
import { join } from 'path'
import { parseArgs } from 'util'
import { BASE_URL, SESSIONS_DIR } from '../config'
import { ensureDaemon, openBrowser } from '../daemon-lifecycle'
import { type AgentHost, injectAgentSupport, parseAgentHosts } from '../inject-skills'
import { scaffold } from '../layout'

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
			profile: { type: 'string', default: 'cf-lightweight' },
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
	const result = scaffold(dir, { profile: values.profile, sessionId: values.session })
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
	if (!values['no-daemon']) {
		const up = await ensureDaemon({ quiet: true })
		if (!result.alreadyInitialized) {
			await resetStaleSession(result.config.sessionId)
			console.error(`[fabrika] cleared any stale session for ${result.config.sessionId}`)
		}
		if (up && !values['no-open']) {
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
		}),
	)
	return 0
}
