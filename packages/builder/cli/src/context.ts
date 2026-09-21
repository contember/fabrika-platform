import { resolve } from 'node:path'
import type { BuilderProjectConnection } from '../../shared'
import { getSessionId } from './config'
import { fabrikaDir, findRepoRoot, readConfig } from './layout'

export interface CommandContext {
	repoRoot: string
	fabrikaDir: string
	sessionId: string
	profile: string
	initialized: boolean
	connection?: BuilderProjectConnection
}

export function resolveContext(opts: { dir?: string; session?: string } = {}): CommandContext {
	const repoRoot = opts.dir
		? resolve(opts.dir)
		: findRepoRoot(process.cwd()) ?? process.cwd()

	const config = readConfig(repoRoot)
	const sessionId = getSessionId(opts.session, config?.sessionId, repoRoot)

	return {
		repoRoot,
		fabrikaDir: fabrikaDir(repoRoot),
		sessionId,
		profile: config?.profile ?? 'cf-lightweight',
		initialized: config !== null,
		...(config?.connection ? { connection: config.connection } : {}),
	}
}
