import { describe, expect, test } from 'bun:test'
import { canvasFilesForRevision } from '../src/lib/canvasSelection'
import type { RevisionMeta } from '../src/lib/types'

function revision(overrides: Partial<RevisionMeta>): RevisionMeta {
	return {
		revision: 2,
		canvasFiles: [],
		...overrides,
	}
}

describe('canvasFilesForRevision', () => {
	test('a single-view revision renders only its explicit entry', () => {
		const files = canvasFilesForRevision(revision({
			canvasScope: { kind: 'view', filename: 'vision.jsx' },
			canvasFiles: [
				{ filename: 'brief.jsx' },
				{ filename: 'vision.jsx' },
			],
		}))

		expect(files.map((file) => file.filename)).toEqual(['vision.jsx'])
	})

	test('an explicit directory revision keeps unchanged files', () => {
		const files = canvasFilesForRevision(revision({
			canvasScope: { kind: 'directory' },
			canvasFiles: [
				{ filename: 'overview.jsx', diffStats: { added: 0, removed: 0 } },
				{ filename: 'details.jsx', diffStats: { added: 4, removed: 1 } },
			],
		}))

		expect(files.map((file) => file.filename)).toEqual(['overview.jsx', 'details.jsx'])
	})

	test('legacy revisions still hide unchanged sibling carry-overs', () => {
		const files = canvasFilesForRevision(revision({
			canvasFiles: [
				{ filename: 'brief.jsx', diffStats: { added: 0, removed: 0 } },
				{ filename: 'vision.jsx', diffStats: { added: 3, removed: 2 } },
			],
		}))

		expect(files.map((file) => file.filename)).toEqual(['vision.jsx'])
	})

	test('legacy re-gates keep the sole unchanged view', () => {
		const files = canvasFilesForRevision(revision({
			canvasFiles: [
				{ filename: 'vision.jsx', diffStats: { added: 0, removed: 0 } },
			],
		}))

		expect(files.map((file) => file.filename)).toEqual(['vision.jsx'])
	})
})
