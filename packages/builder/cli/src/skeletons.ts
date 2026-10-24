import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, join } from 'path'

export interface Skeleton {
	file: string
	name: string
	url?: string
	seeds: string[]
	roles: string[]
	feature?: string
	invariants: string[]
}

export function readSkeletons(testsBrowserDir: string): Skeleton[] {
	if (!existsSync(testsBrowserDir) || !statSync(testsBrowserDir).isDirectory()) return []
	const out: Skeleton[] = []
	for (const entry of readdirSync(testsBrowserDir).sort()) {
		if (!entry.endsWith('.test.ts')) continue
		const file = join(testsBrowserDir, entry)
		if (!statSync(file).isFile() || statSync(file).size === 0) continue
		out.push(...parseSkeletons(file))
	}
	return out
}

export function parseSkeletons(file: string): Skeleton[] {
	const src = readFileSync(file, 'utf-8')
	const scenarios: Skeleton[] = []
	const re = /browserTest\s*\(/g
	let m: RegExpExecArray | null
	while ((m = re.exec(src))) {
		const objStart = src.indexOf('{', m.index)
		if (objStart === -1) continue
		const objEnd = matchBrace(src, objStart)
		if (objEnd === -1) continue
		const meta = src.slice(objStart, objEnd + 1)
		const bodyEnd = matchParen(src, m.index + m[0].length - 1)
		const body = bodyEnd !== -1 ? src.slice(objEnd + 1, bodyEnd) : src.slice(objEnd + 1)

		scenarios.push({
			file,
			name: strField(meta, 'name') ?? basename(file).replace(/\.test\.ts$/, ''),
			url: urlPath(strField(meta, 'url')),
			seeds: arrField(meta, 'seeds'),
			roles: arrField(meta, 'roles'),
			feature: strField(meta, 'feature'),
			invariants: invariantNames(body),
		})
	}
	return scenarios
}

function strField(meta: string, key: string): string | undefined {
	const re = new RegExp(`\\b${key}\\s*:\\s*([\`'"])([\\s\\S]*?)\\1`)
	const m = meta.match(re)
	return m ? m[2] : undefined
}

function arrField(meta: string, key: string): string[] {
	const re = new RegExp(`\\b${key}\\s*:\\s*\\[([\\s\\S]*?)\\]`)
	const m = meta.match(re)
	if (!m || !m[1]) return []
	return [...m[1].matchAll(/[`'"]([^`'"]+)[`'"]/g)].map((x) => x[1]!).filter(Boolean)
}

function urlPath(url: string | undefined): string | undefined {
	if (!url) return undefined
	let s = url.replace(/\$\{[^}]*\}/g, '') // drop a leading ${BASE} template expr
	s = s.replace(/^https?:\/\/[^/]+/, '') // drop a literal protocol + host
	const hash = s.indexOf('#')
	if (hash !== -1) s = s.slice(0, hash)
	const qs = s.indexOf('?')
	if (qs !== -1) s = s.slice(0, qs)
	if (!s.startsWith('/')) s = '/' + s
	s = s.replace(/\/{2,}/g, '/')
	return s || '/'
}

function invariantNames(body: string): string[] {
	const names: string[] = []
	for (const mm of body.matchAll(/invariant(?:\.todo|\.blocked|\.fixme)?\s*\(\s*([`'"])([\s\S]*?)\1/g)) {
		if (mm[2]) names.push(mm[2])
	}
	return names
}

function matchBrace(s: string, open: number): number {
	return matchPair(s, open, '{', '}')
}
function matchParen(s: string, open: number): number {
	return matchPair(s, open, '(', ')')
}
function matchPair(s: string, open: number, l: string, r: string): number {
	let depth = 0
	for (let i = open; i < s.length; i++) {
		const c = s[i]
		if (c === l) depth++
		else if (c === r) {
			depth--
			if (depth === 0) return i
		}
	}
	return -1
}
