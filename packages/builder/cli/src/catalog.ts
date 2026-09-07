import { existsSync, statSync } from 'fs'
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

export interface StackPointer {
	profile: string
	root: string
	stackFile: string
	stackFileExists: boolean
	decisionsDir: string
}

export function resolveStackPointer(profile: string): StackPointer | null {
	const root = resolveCatalogRoot()
	if (!root) return null
	const stackFile = join(root, 'stacks', `${profile}.md`)
	return {
		profile,
		root,
		stackFile,
		stackFileExists: existsSync(stackFile) && statSync(stackFile).isFile(),
		decisionsDir: join(root, 'decisions'),
	}
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory()
	} catch {
		return false
	}
}
