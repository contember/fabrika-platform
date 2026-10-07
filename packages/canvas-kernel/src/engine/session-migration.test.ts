/**
 * The older on-disk format SessionManager still has to read: one sourceFile
 * per revision. Loading runs inside the catch in loadFromDisk — so a mistake
 * here costs work rather than raising.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager } from './session'
import type { SessionData } from './session'

const PROJECT_ROOT = '/projects/alpha'
const CREATED_AT = '2026-02-01T08:00:00.000Z'
const UPDATED_AT = '2026-02-03T16:00:00.000Z'

const testDirectories: string[] = []

function createDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'agent-canvas-migration-'))
	testDirectories.push(directory)
	return directory
}

function requireSession(manager: SessionManager, id: string): SessionData {
	const session = manager.get(id)
	if (!session) throw new Error(`session "${id}" is missing`)
	return session
}

function readMeta(dir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'))
}

afterEach(() => {
	for (const directory of testDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

describe('one-sourceFile-per-revision format', () => {
	test('sourceFile and diffStats become the canvasFiles list', () => {
		const root = createDirectory()
		const dir = join(root, 'plan')
		mkdirSync(join(dir, 'revisions', '2'), { recursive: true })
		writeFileSync(join(dir, 'revisions', '2', 'design.jsx'), '<Section>two</Section>')
		writeFileSync(
			join(dir, 'meta.json'),
			JSON.stringify(
				{
					projectRoot: PROJECT_ROOT,
					createdAt: CREATED_AT,
					updatedAt: UPDATED_AT,
					currentRevision: 2,
					revisions: [
						{ revision: 1, sourceFile: 'design.jsx', createdAt: CREATED_AT, hasFeedback: true, feedbackConsumed: true },
						{
							revision: 2,
							label: 'Second pass',
							sourceFile: 'design.jsx',
							createdAt: UPDATED_AT,
							hasFeedback: false,
							feedbackConsumed: false,
							diffStats: { added: 4, removed: 1 },
						},
					],
				},
				null,
				2,
			),
		)

		const session = requireSession(new SessionManager(root), 'plan')

		expect(session.canvasFiles).toEqual(['design.jsx'])
		expect(session.revisions[1]).toMatchObject({
			revision: 2,
			label: 'Second pass',
			canvasFiles: [{ filename: 'design.jsx', diffStats: { added: 4, removed: 1 } }],
		})
		// The feedback state each revision was in has to survive the rewrite.
		expect(session.revisions[0]).toMatchObject({ hasFeedback: true, feedbackConsumed: true })
		// Rewritten on disk, so the next start reads the current shape.
		expect(readMeta(dir)['revisions']).toEqual(session.revisions)
	})

	test('a revision with no sourceFile is assumed to be plan.jsx', () => {
		const root = createDirectory()
		const dir = join(root, 'plan')
		mkdirSync(join(dir, 'revisions', '1'), { recursive: true })
		writeFileSync(join(dir, 'revisions', '1', 'plan.jsx'), '<Section>one</Section>')
		writeFileSync(
			join(dir, 'meta.json'),
			JSON.stringify(
				{
					projectRoot: PROJECT_ROOT,
					createdAt: CREATED_AT,
					updatedAt: UPDATED_AT,
					currentRevision: 1,
					revisions: [{ revision: 1, createdAt: CREATED_AT, hasFeedback: false, feedbackConsumed: false }],
				},
				null,
				2,
			),
		)

		const session = requireSession(new SessionManager(root), 'plan')
		expect(session.revisions[0]?.canvasFiles).toEqual([{ filename: 'plan.jsx' }])
	})
})

describe('a session that cannot be read', () => {
	test('says so, and does not take the other sessions down with it', () => {
		const root = createDirectory()
		new SessionManager(root).upsert('plan', new Map([['plan.jsx', '<Section>one</Section>']]), PROJECT_ROOT)
		mkdirSync(join(root, 'broken'), { recursive: true })
		writeFileSync(join(root, 'broken', 'meta.json'), '{ not json')

		const warn = spyOn(console, 'warn').mockImplementation(() => {})
		try {
			const manager = new SessionManager(root)

			expect(manager.list().map((s) => s.id)).toEqual(['plan'])
			// Losing a session in silence is how a failed load goes unnoticed.
			const messages = warn.mock.calls.map((call) => String(call[0]))
			expect(messages.some((m) => m.includes('broken'))).toBe(true)
		} finally {
			warn.mockRestore()
		}
	})
})
