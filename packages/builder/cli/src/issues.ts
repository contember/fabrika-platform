import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, join } from 'path'
import { BuilderCliError } from './errors'
import { extractFrontMatter, list, scalar } from './frontmatter'

export interface Issue {
	id: string
	path: string
	goal: string
	satisfies: string[]
	dependsOn: string[]
	touches: string[]
	/** Repository-relative acceptance files `build done` runs; empty for an issue whose check the driver names. */
	verify: string[]
	/** A review gate whose verdict `build done` records instead of running a check. */
	gate?: string
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
	const gate = gateName(path, fm.body['gate'])
	return {
		id: basename(path).replace(/\.md$/i, ''),
		path,
		goal: scalar(fm.body['goal']) ?? '',
		satisfies: list(fm.body['satisfies']),
		dependsOn: list(fm.body['depends_on']),
		touches: list(fm.body['touches']),
		verify: list(fm.body['verify']),
		...(gate ? { gate } : {}),
		body: fm.rest,
	}
}

export function isReady(issue: Issue, knownIds: Set<string>): boolean {
	return issue.dependsOn.every((dep) => knownIds.has(dep))
}

// The name reaches a daemon URL; an issue that names an invalid one is refused, never read as ungated.
function gateName(path: string, v: string | undefined): string | undefined {
	const name = scalar(v)
	if (!name) return undefined
	if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new BuilderCliError(`${path}: "${name}" is not a gate name (lowercase letters, digits and dashes).`)
	return name
}
