import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { z } from 'zod'
import type { Issue } from './issues'

export type IssueStatus = 'done' | 'blocked'

export interface BuildRecord {
	status: IssueStatus
	reason?: string
	at: string
}

export type BuildBoard = Record<string, BuildRecord>

const buildBoardSchema = z.record(
	z.object({ status: z.enum(['done', 'blocked']), at: z.string(), reason: z.string().optional() })
		.transform(({ status, at, reason }) => ({ status, at, ...(reason === undefined ? {} : { reason }) })),
)

function parseBoard(value: unknown): BuildBoard | null {
	const result = buildBoardSchema.safeParse(value)
	return result.success ? result.data : null
}

function boardPath(fabrikaDir: string): string {
	return join(fabrikaDir, 'build', 'status.json')
}

export function readBoard(fabrikaDir: string): BuildBoard {
	const p = boardPath(fabrikaDir)
	if (!existsSync(p)) return {}
	try {
		const board = parseBoard(JSON.parse(readFileSync(p, 'utf-8')))
		return board ?? {}
	} catch {
		return {}
	}
}

export function writeBoard(fabrikaDir: string, board: BuildBoard): void {
	const p = boardPath(fabrikaDir)
	mkdirSync(dirname(p), { recursive: true })
	writeFileSync(p, JSON.stringify(board, null, 2) + '\n')
}

export function record(
	fabrikaDir: string,
	id: string,
	status: IssueStatus,
	reason: string | undefined,
	at: string,
): BuildBoard {
	const board = readBoard(fabrikaDir)
	board[id] = { status, ...(reason ? { reason } : {}), at }
	writeBoard(fabrikaDir, board)
	return board
}

export interface BuildPlan {
	done: Issue[]
	blocked: Issue[]
	ready: Issue[]
	waiting: Issue[]
	next: Issue | null
	complete: boolean
}

export function planBuild(issues: Issue[], board: BuildBoard): BuildPlan {
	const statusOf = (id: string): IssueStatus | undefined => board[id]?.status
	const doneIds = new Set(issues.filter((i) => statusOf(i.id) === 'done').map((i) => i.id))

	const done: Issue[] = []
	const blocked: Issue[] = []
	const ready: Issue[] = []
	const waiting: Issue[] = []

	for (const issue of issues) {
		const s = statusOf(issue.id)
		if (s === 'done') {
			done.push(issue)
			continue
		}
		if (s === 'blocked') {
			blocked.push(issue)
			continue
		}
		const depsDone = issue.dependsOn.every((d) => doneIds.has(d))
		if (depsDone) ready.push(issue)
		else waiting.push(issue)
	}

	return {
		done,
		blocked,
		ready,
		waiting,
		next: ready[0] ?? null,
		complete: ready.length === 0 && waiting.length === 0 && done.length + blocked.length === issues.length && issues.length > 0,
	}
}
