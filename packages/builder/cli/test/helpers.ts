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

export function makeFixture(init = true): Fixture {
	const root = mkdtempSync(join(tmpdir(), 'fabrika-test-'))
	if (init) {
		scaffold(root, { profile: 'cf-lightweight', sessionId: 's_test' })
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
