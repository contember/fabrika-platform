import { describe, expect, test } from 'bun:test'
import { type BuildBoard, planBuild } from '../src/build-status'
import type { Issue } from '../src/issues'

function issue(id: string, dependsOn: string[] = []): Issue {
	return { id, path: `${id}.md`, goal: id, satisfies: [], dependsOn, touches: [], body: '' }
}

const ISSUES: Issue[] = [
	issue('ISSUE-001'),
	issue('ISSUE-002', ['ISSUE-001']),
	issue('ISSUE-101', ['ISSUE-001', 'ISSUE-002']),
	issue('ISSUE-102', ['ISSUE-001']),
]

describe('planBuild', () => {
	test('empty board: only dep-free issues are ready', () => {
		const p = planBuild(ISSUES, {})
		expect(p.ready.map((i) => i.id)).toEqual(['ISSUE-001'])
		expect(p.waiting.map((i) => i.id)).toEqual(['ISSUE-002', 'ISSUE-101', 'ISSUE-102'])
		expect(p.next?.id).toBe('ISSUE-001')
		expect(p.complete).toBe(false)
	})

	test('done propagates readiness to dependents', () => {
		const board: BuildBoard = { 'ISSUE-001': { status: 'done', at: 't' } }
		const p = planBuild(ISSUES, board)
		expect(p.done.map((i) => i.id)).toEqual(['ISSUE-001'])
		expect(p.ready.map((i) => i.id)).toEqual(['ISSUE-002', 'ISSUE-102'])
		expect(p.waiting.map((i) => i.id)).toEqual(['ISSUE-101'])
	})

	test('a blocked dependency keeps dependents waiting (not ready)', () => {
		const board: BuildBoard = {
			'ISSUE-001': { status: 'done', at: 't' },
			'ISSUE-002': { status: 'blocked', reason: 'x', at: 't' },
		}
		const p = planBuild(ISSUES, board)
		expect(p.ready.map((i) => i.id)).toEqual(['ISSUE-102'])
		expect(p.waiting.map((i) => i.id)).toEqual(['ISSUE-101'])
		expect(p.blocked.map((i) => i.id)).toEqual(['ISSUE-002'])
	})

	test('complete when everything is done or blocked with nothing buildable', () => {
		const board: BuildBoard = {
			'ISSUE-001': { status: 'done', at: 't' },
			'ISSUE-002': { status: 'blocked', reason: 'x', at: 't' },
			'ISSUE-102': { status: 'done', at: 't' },
		}
		const p = planBuild(ISSUES, board)
		expect(p.next).toBeNull()
		expect(p.complete).toBe(false)
		expect(p.waiting.map((i) => i.id)).toEqual(['ISSUE-101'])
	})

	test('fully done → complete', () => {
		const board: BuildBoard = {}
		for (const issue of ISSUES) board[issue.id] = { status: 'done', at: 't' }
		const p = planBuild(ISSUES, board)
		expect(p.complete).toBe(true)
		expect(p.next).toBeNull()
	})
})
