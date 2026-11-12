import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))

export function resolveCatalogRoot(): string | null {
	const candidates = [resolve(HERE, '../..')]
	for (const c of candidates) {
		if (isDir(join(c, 'stacks')) && isDir(join(c, 'decisions'))) return c
	}
	return null
}

/** The project profile a new project gets; `zerops-app` is the paved road the builder connects and deploys. */
export const DEFAULT_PROFILE = 'zerops-app'

/** `unsupported`: a preset kept for reference that leaves the paved road (no contract, proxy, kit or checker). */
export type StackSupport = 'supported' | 'unsupported'

export interface StackPointer {
	profile: string
	root: string
	stackFile: string
	stackFileExists: boolean
	decisionsDir: string
	/** Null when the preset file does not exist. */
	support: StackSupport | null
}

export function resolveStackPointer(profile: string): StackPointer | null {
	const root = resolveCatalogRoot()
	if (!root) return null
	const stackFile = join(root, 'stacks', `${profile}.md`)
	const stackFileExists = existsSync(stackFile) && statSync(stackFile).isFile()
	return {
		profile,
		root,
		stackFile,
		stackFileExists,
		decisionsDir: join(root, 'decisions'),
		support: stackFileExists ? stackSupport(readFileSync(stackFile, 'utf8')) : null,
	}
}

/** The ids of the presets the builder supports, for pointing away from an unsupported one. */
export function supportedProfiles(): string[] {
	const root = resolveCatalogRoot()
	if (!root) return []
	return readdirSync(join(root, 'stacks'))
		.filter((name) => name.endsWith('.md') && name !== 'README.md')
		.filter((name) => stackSupport(readFileSync(join(root, 'stacks', name), 'utf8')) === 'supported')
		.map((name) => name.slice(0, -'.md'.length))
		.sort()
}

export function unsupportedProfileNote(profile: string): string {
	return `the "${profile}" preset is unsupported: it leaves the paved road (contract, proxy, @fabrika/ui, @fabrika/db, fabrika-check). `
		+ `Supported presets: ${supportedProfiles().join(', ')}.`
}

// A preset that does not say it is supported is treated as unsupported.
function stackSupport(source: string): StackSupport {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? ''
	return /^support:\s*supported\s*$/m.test(frontmatter) ? 'supported' : 'unsupported'
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory()
	} catch {
		return false
	}
}
