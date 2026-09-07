import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, join } from 'path'

export interface Issue {
	id: string
	path: string
	goal: string
	satisfies: string[]
	dependsOn: string[]
	touches: string[]
	body: string
}

export function readIssues(fabrikaDir: string): Issue[] {
	const dir = join(fabrikaDir, 'issues')
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
	const out: Issue[] = []
	for (const entry of readdirSync(dir)) {
		if (!/^ISSUE-.*\.md$/i.test(entry)) continue
		const p = join(dir, entry)
		if (!statSync(p).isFile() || statSync(p).size === 0) continue
		out.push(parseIssue(p))
	}
	out.sort((a, b) => a.id.localeCompare(b.id))
	return out
}

export function parseIssue(path: string): Issue {
	const raw = readFileSync(path, 'utf-8')
	const fm = extractFrontMatter(raw)
	return {
		id: basename(path).replace(/\.md$/i, ''),
		path,
		goal: scalar(fm.body['goal']) ?? '',
		satisfies: list(fm.body['satisfies']),
		dependsOn: list(fm.body['depends_on']),
		touches: list(fm.body['touches']),
		body: fm.rest,
	}
}

export function isReady(issue: Issue, knownIds: Set<string>): boolean {
	return issue.dependsOn.every((dep) => knownIds.has(dep))
}

interface FrontMatter {
	body: Record<string, string>
	rest: string
}

function extractFrontMatter(raw: string): FrontMatter {
	const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
	if (!m) return { body: {}, rest: raw }
	const body: Record<string, string> = {}
	for (const line of (m[1] ?? '').split(/\r?\n/)) {
		const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
		if (kv && kv[1]) body[kv[1]] = (kv[2] ?? '').trim()
	}
	return { body, rest: (m[2] ?? '').trim() }
}

function scalar(v: string | undefined): string | undefined {
	if (v === undefined) return undefined
	return v.replace(/^["']|["']$/g, '')
}

function list(v: string | undefined): string[] {
	if (!v) return []
	const inner = v.replace(/^\[/, '').replace(/\]$/, '')
	if (inner.trim() === '') return []
	return inner
		.split(',')
		.map((s) => s.trim().replace(/^["']|["']$/g, ''))
		.filter((s) => s.length > 0)
}
