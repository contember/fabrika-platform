import type { SessionManager } from '@fabrika/canvas-kernel/server'
import { jsonResponse, type Route } from '@fabrika/daemon-kit'
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

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
const RULE_RE = /\s*([^{}]+?)\s*\{([^{}]*)\}\s*/y

export type ThemeResult = { ok: true; css: string } | { ok: false; error: string }

/** The project theme as the daemon serves it, or why it is refused. A refused theme is not served at all. */
export function parseProjectTheme(source: string): ThemeResult {
	const text = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
	const rules: string[] = []
	RULE_RE.lastIndex = 0
	while (RULE_RE.lastIndex < text.length) {
		const start = RULE_RE.lastIndex
		const match = RULE_RE.exec(text)
		if (match === null) {
			if (text.slice(start).trim() === '') break
			return { ok: false, error: `Only rules of the form "selector { --color-…: value; }" are allowed, at offset ${start}` }
		}
		const [, selectorList = '', body = ''] = match
		const selectors: string[] = []
		for (const raw of selectorList.split(',')) {
			const selector = SELECTORS.get(raw.trim().replace(/\s+/g, ''))
			if (selector === undefined) {
				return { ok: false, error: `Selector ${JSON.stringify(raw.trim())} is not allowed; use :root or [data-theme="light"|"dark"]` }
			}
			selectors.push(selector)
		}
		const declarations: string[] = []
		for (const raw of body.split(';')) {
			if (raw.trim() === '') continue
			const colon = raw.indexOf(':')
			const property = raw.slice(0, colon).trim()
			const value = raw.slice(colon + 1).trim()
			if (colon < 0 || !PROPERTY_RE.test(property)) {
				return { ok: false, error: `Only --color-* and --font-* properties are allowed, not ${JSON.stringify(raw.trim())}` }
			}
			if (value === '' || value.length > MAX_VALUE_LENGTH || !VALUE_RE.test(value) || FETCHING_RE.test(value)) {
				return { ok: false, error: `The value of ${property} is not a plain colour or font list` }
			}
			declarations.push(`  ${property}: ${value};`)
		}
		rules.push(`${selectors.join(', ')} {\n${declarations.join('\n')}\n}`)
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
