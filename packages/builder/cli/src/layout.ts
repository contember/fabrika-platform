import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type BuilderProjectConfig, parseBuilderProjectConfig } from '../../shared'
import { FABRIKA_DIRNAME, hashRepoPath } from './config'
import { BuilderCliError } from './errors'

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

export type FabrikaConfig = BuilderProjectConfig

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
		return parseBuilderProjectConfig(JSON.parse(readFileSync(p, 'utf-8')))
	} catch {
		throw new BuilderCliError('Invalid .fabrika/config.json; repair it before continuing.')
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
	const existing = readConfig(root)

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
