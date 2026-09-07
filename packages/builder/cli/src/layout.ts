import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { FABRIKA_DIRNAME, hashRepoPath } from './config'

export const LAYER_DIRS = [
	'intent',
	'principles',
	'architecture',
	'architecture/flows',
	'architecture/spec',
	'pages',
	'issues',
]

export const EXTERNAL_DIRS = ['tests/browser']

export interface FabrikaConfig {
	profile: string
	sessionId: string
	createdAt: string
}

function parseConfig(value: unknown): FabrikaConfig | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
	if (!('profile' in value) || !('sessionId' in value) || !('createdAt' in value)) return null
	const { profile, sessionId, createdAt } = value
	if (typeof profile !== 'string' || typeof sessionId !== 'string' || typeof createdAt !== 'string') return null
	return { profile, sessionId, createdAt }
}

export function fabrikaDir(repoRoot: string): string {
	return join(resolve(repoRoot), FABRIKA_DIRNAME)
}

export function configPath(repoRoot: string): string {
	return join(fabrikaDir(repoRoot), 'config.json')
}

export function isInitialized(repoRoot: string): boolean {
	return existsSync(configPath(repoRoot))
}

export function readConfig(repoRoot: string): FabrikaConfig | null {
	const p = configPath(repoRoot)
	if (!existsSync(p)) return null
	try {
		return parseConfig(JSON.parse(readFileSync(p, 'utf-8')))
	} catch {
		return null
	}
}

export interface InitResult {
	repoRoot: string
	fabrikaDir: string
	config: FabrikaConfig
	createdDirs: string[]
	createdConfig: boolean
	alreadyInitialized: boolean
}

export function scaffold(
	repoRoot: string,
	opts: { profile?: string; sessionId?: string } = {},
): InitResult {
	const root = resolve(repoRoot)
	const fdir = fabrikaDir(root)
	const profile = opts.profile ?? 'cf-lightweight'
	const createdDirs: string[] = []

	const alreadyInitialized = isInitialized(root)

	for (const dir of ['.', ...LAYER_DIRS]) {
		const abs = dir === '.' ? fdir : join(fdir, dir)
		if (!existsSync(abs)) {
			mkdirSync(abs, { recursive: true })
			createdDirs.push(abs)
		}
	}

	for (const dir of EXTERNAL_DIRS) {
		const abs = join(root, dir)
		if (!existsSync(abs)) {
			mkdirSync(abs, { recursive: true })
			createdDirs.push(abs)
		}
	}

	let config: FabrikaConfig
	let createdConfig = false
	const existing = readConfig(root)
	if (existing) {
		config = existing
	} else {
		config = {
			profile,
			sessionId: opts.sessionId ?? hashRepoPath(root),
			createdAt: new Date().toISOString(),
		}
		writeFileSync(configPath(root), JSON.stringify(config, null, 2) + '\n')
		createdConfig = true
	}

	return {
		repoRoot: root,
		fabrikaDir: fdir,
		config,
		createdDirs,
		createdConfig,
		alreadyInitialized,
	}
}

export function findRepoRoot(start: string = process.cwd()): string | null {
	let dir = resolve(start)
	while (true) {
		if (existsSync(join(dir, FABRIKA_DIRNAME)) && statSync(join(dir, FABRIKA_DIRNAME)).isDirectory()) {
			return dir
		}
		const parent = resolve(dir, '..')
		if (parent === dir) return null
		dir = parent
	}
}
