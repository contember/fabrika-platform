import type { SessionManager } from '@fabrika/canvas-kernel/server'
import { jsonResponse, type Route } from '@fabrika/daemon-kit'
import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { isAbsolute, join, relative, sep } from 'path'

/**
 * A project's brand for its canvases: `<projectRoot>/.agent-canvas/theme.css`, served after the base theme. Only
 * `--color-*` and `--font-*` custom properties on `:root` or a `[data-theme]` mode are accepted, and the daemon serves
 * its own rebuild of them, never the file's text, so a theme cannot load a URL, import a stylesheet or style the page.
 */

export const PROJECT_THEME_PATH = join('.agent-canvas', 'theme.css')
const MAX_THEME_BYTES = 64 * 1024
const MAX_VALUE_LENGTH = 200

const SELECTORS = new Map([
	[':root', ':root'],
	['[data-theme="light"]', '[data-theme="light"]'],
	["[data-theme='light']", '[data-theme="light"]'],
	['[data-theme=light]', '[data-theme="light"]'],
	['[data-theme="dark"]', '[data-theme="dark"]'],
	["[data-theme='dark']", '[data-theme="dark"]'],
	['[data-theme=dark]', '[data-theme="dark"]'],
])
const PROPERTY_RE = /^--(?:color|font)-[a-z0-9]+(?:-[a-z0-9]+)*$/
// Colours and font stacks need no more; no `;`, braces, backslash escapes or `@`.
const VALUE_RE = /^[A-Za-z0-9#%.,()'" +\-/]+$/
// Functions that fetch or embed a resource.
const FETCHING_RE = /\b(?:url|image|image-set|cross-fade|element|src)\s*\(/i
// No quantifier here can match the same text as another, so a failed match stays linear.
const RULE_RE = /([^{}]*)\{([^{}]*)\}/y
const WHITESPACE_RE = /\s*/y

export type ThemeResult = { ok: true; css: string } | { ok: false; error: string }

/** Parentheses nest and close, and a quote closes before any parenthesis around it does. */
function balanced(value: string): boolean {
	const open: string[] = []
	for (const char of value) {
		const top = open.at(-1)
		if (top === "'" || top === '"') {
			if (char === top) open.pop()
		} else if (char === '(' || char === "'" || char === '"') {
			open.push(char)
		} else if (char === ')') {
			if (open.pop() !== '(') return false
		}
	}
	return open.length === 0
}

/** Comments as spaces of the same length, so offsets still point into the file; null for an unclosed one. */
function blankComments(source: string): string | null {
	let text = ''
	let position = 0
	for (;;) {
		const start = source.indexOf('/*', position)
		if (start < 0) return text + source.slice(position)
		const end = source.indexOf('*/', start + 2)
		if (end < 0) return null
		text += source.slice(position, start) + source.slice(start, end + 2).replace(/[^\n]/g, ' ')
		position = end + 2
	}
}

/** The project theme as the daemon serves it, or why it is refused. A refused theme is not served at all. */
export function parseProjectTheme(source: string): ThemeResult {
	const text = blankComments(source)
	if (text === null) return { ok: false, error: 'a comment is not closed' }
	// Errors name a line and at most an accepted property name, never a value: the reason reaches the page and the log.
	const lineAt = (offset: number) => text.slice(0, offset).split('\n').length
	const rules: string[] = []
	let position = 0
	for (;;) {
		WHITESPACE_RE.lastIndex = position
		WHITESPACE_RE.exec(text)
		position = WHITESPACE_RE.lastIndex
		if (position >= text.length) break
		RULE_RE.lastIndex = position
		const match = RULE_RE.exec(text)
		if (match === null) return { ok: false, error: `line ${lineAt(position)}: only rules of the form "selector { --color-…: value; }" are allowed` }
		const [, selectorList = '', body = ''] = match
		const selectors: string[] = []
		for (const raw of selectorList.split(',')) {
			const selector = SELECTORS.get(raw.trim().replace(/\s+/g, ''))
			if (selector === undefined) {
				return { ok: false, error: `line ${lineAt(position)}: only :root and [data-theme="light"|"dark"] selectors are allowed` }
			}
			selectors.push(selector)
		}
		const bodyStart = match.index + selectorList.length + 1
		const declarations: string[] = []
		let offset = bodyStart
		for (const raw of body.split(';')) {
			const at = offset + raw.length - raw.trimStart().length
			offset += raw.length + 1
			if (raw.trim() === '') continue
			const colon = raw.indexOf(':')
			const property = raw.slice(0, colon).trim()
			const value = raw.slice(colon + 1).trim()
			if (colon < 0 || !PROPERTY_RE.test(property)) return { ok: false, error: `line ${lineAt(at)}: only --color-* and --font-* properties are allowed` }
			if (value === '' || value.length > MAX_VALUE_LENGTH || !VALUE_RE.test(value) || FETCHING_RE.test(value) || !balanced(value)) {
				return { ok: false, error: `line ${lineAt(at)}: the value of ${property} is not a plain colour or font list` }
			}
			declarations.push(`  ${property}: ${value};`)
		}
		rules.push(`${selectors.join(', ')} {\n${declarations.join('\n')}\n}`)
		position = RULE_RE.lastIndex
	}
	return { ok: true, css: rules.length === 0 ? '' : `${rules.join('\n')}\n` }
}

export function createThemeHandlers(sessionManager: SessionManager): Route[] {
	function handleTheme(_req: Request, _url: URL, match: URLPatternResult): Response {
		const session = sessionManager.get(match.pathname.groups['id'] ?? '')
		if (!session) return jsonResponse({ error: 'Session not found' }, 404)
		const path = join(session.projectRoot, PROJECT_THEME_PATH)
		// No project theme: the base theme stands.
		if (!existsSync(path)) return css('')
		let source: string
		try {
			// A symlink may not lead out of the project, e.g. into the daemon's own state.
			const real = relative(realpathSync(session.projectRoot), realpathSync(path))
			if (real === '..' || real.startsWith(`..${sep}`) || isAbsolute(real)) {
				return jsonResponse({ error: `${PROJECT_THEME_PATH} leads outside the project` }, 422)
			}
			const stat = statSync(path)
			if (!stat.isFile()) return jsonResponse({ error: `${PROJECT_THEME_PATH} is not a file` }, 422)
			if (stat.size > MAX_THEME_BYTES) return jsonResponse({ error: `${PROJECT_THEME_PATH} is larger than ${MAX_THEME_BYTES / 1024} KB` }, 422)
			source = readFileSync(path, 'utf-8')
		} catch (error) {
			console.error(`[agent-canvas] cannot read ${path}:`, error)
			return jsonResponse({ error: `${PROJECT_THEME_PATH} could not be read` }, 500)
		}
		const theme = parseProjectTheme(source)
		if (!theme.ok) {
			console.error(`[agent-canvas] ${path} refused: ${theme.error}`)
			return jsonResponse({ error: `${PROJECT_THEME_PATH}: ${theme.error}` }, 422)
		}
		return css(theme.css)
	}

	return [{ method: 'GET', pattern: new URLPattern({ pathname: '/api/session/:id/theme.css' }), handler: handleTheme }]
}

function css(body: string): Response {
	return new Response(body, {
		headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
	})
}
