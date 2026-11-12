import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { scaffold } from '../src/layout'

export interface Fixture {
	root: string
	fabrikaDir: string
	write(rel: string, content?: string): void
	writeEmpty(rel: string): void
	cleanup(): void
}

/** `approvals: false` (the default) drops the approvals file `init` writes: the project derives from files and reviews alone, as one initialized before approvals existed. */
export function makeFixture(init = true, opts: { approvals?: boolean } = {}): Fixture {
	const root = mkdtempSync(join(tmpdir(), 'fabrika-test-'))
	if (init) {
		scaffold(root, { profile: 'cf-lightweight', sessionId: 's_test' })
		if (!opts.approvals) rmSync(join(root, '.fabrika', 'approvals.json'))
	}
	const fabrikaDir = join(root, '.fabrika')

	const write = (rel: string, content = 'x') => {
		const abs = join(root, rel)
		mkdirSync(dirname(abs), { recursive: true })
		writeFileSync(abs, content)
	}
	const writeEmpty = (rel: string) => {
		const abs = join(root, rel)
		mkdirSync(dirname(abs), { recursive: true })
		writeFileSync(abs, '')
	}
	const cleanup = () => {
		try {
			rmSync(root, { recursive: true, force: true })
		} catch {}
	}

	return { root, fabrikaDir, write, writeEmpty, cleanup }
}
