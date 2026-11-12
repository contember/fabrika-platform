import { SessionManager } from '@fabrika/canvas-kernel/server'
import { dispatch } from '@fabrika/daemon-kit'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createThemeHandlers, parseProjectTheme, PROJECT_THEME_PATH } from './handlers/theme'

const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function setup(theme?: string) {
	const directory = mkdtempSync(join(tmpdir(), 'agent-canvas-theme-'))
	directories.push(directory)
	const projectRoot = join(directory, 'project')
	mkdirSync(join(projectRoot, '.agent-canvas'), { recursive: true })
	if (theme !== undefined) writeFileSync(join(projectRoot, PROJECT_THEME_PATH), theme)
	const manager = new SessionManager(join(directory, 'sessions'))
	manager.upsert('themed', new Map([['plan.jsx', '<Section title="Plan" />']]), projectRoot)
	const routes = createThemeHandlers(manager)
	const get = async (sessionId = 'themed') => {
		const url = new URL(`http://localhost:19400/api/session/${sessionId}/theme.css`)
		const response = await dispatch(routes, new Request(url), url)
		if (!response) throw new Error('No theme route')
		return response
	}
	return { get, projectRoot }
}

describe('parseProjectTheme', () => {
	test('rebuilds colour and font overrides for :root and each mode', () => {
		const result = parseProjectTheme(`
/* Brand */
:root { --color-accent-blue: #0055ff; --font-heading: 'Brand Serif', Georgia, serif }
[data-theme='light'], [data-theme=dark] {
  --color-bg-base: rgb(250 250 250 / 0.9);
}
`)
		expect(result).toEqual({
			ok: true,
			css: ":root {\n  --color-accent-blue: #0055ff;\n  --font-heading: 'Brand Serif', Georgia, serif;\n}\n"
				+ '[data-theme="light"], [data-theme="dark"] {\n  --color-bg-base: rgb(250 250 250 / 0.9);\n}\n',
		})
	})

	test('refuses anything but colour and font variables on the allowed selectors', () => {
		const refused = [
			'@import url("https://example.com/x.css");',
			':root { --color-bg-base: url(https://example.com/pixel.png); }',
			':root { --color-bg-base: image-set("x.png" 1x); }',
			':root { color: red; }',
			':root { --shadow-sm: none; }',
			'body { --color-bg-base: red; }',
			'.canvas, :root { --color-bg-base: red; }',
			':root { --color-bg-base: red } }',
			':root { --color-bg-base: "\\\\61"; }',
			'@font-face { font-family: X; src: url(x.woff2); }',
			':root { --color-bg-base: red; } garbage',
			':root { --color-text-tertiary: rgb(; --color-accent-blue: #ff00aa }',
			':root { --color-text-tertiary: "Brand; --font-body: x }',
			':root { --color-text-tertiary: rgb(1 2 3)) }',
		]
		for (const source of refused) expect(parseProjectTheme(source)).toMatchObject({ ok: false })
	})

	test('a refusal names the line, not the text it refused', () => {
		const result = parseProjectTheme(':root {\n  --color-bg-base: red;\n}\nsecret-selector-text { --color-x: red }')
		expect(result).toEqual({ ok: false, error: expect.stringContaining('line 4') })
		expect(JSON.stringify(result)).not.toContain('secret-selector-text')
	})

	test('stays linear on input made to backtrack', () => {
		const started = performance.now()
		for (const source of [`${' '.repeat(60_000)}{`, `:root${' '.repeat(60_000)}`, `${'a '.repeat(30_000)}{`]) {
			expect(parseProjectTheme(source)).toMatchObject({ ok: false })
		}
		expect(parseProjectTheme(':root{--color-a:red}\n'.repeat(3_000))).toMatchObject({ ok: true })
		expect(parseProjectTheme('/*'.repeat(30_000))).toMatchObject({ ok: false })
		expect(performance.now() - started).toBeLessThan(500)
	})

	test('an empty or comment-only file is an empty theme', () => {
		expect(parseProjectTheme('')).toEqual({ ok: true, css: '' })
		expect(parseProjectTheme('/* nothing yet */\n')).toEqual({ ok: true, css: '' })
	})
})

describe('project theme route', () => {
	test("serves the rebuilt theme from the session's project root, as CSS that is never cached", async () => {
		const { get } = setup(':root{--color-accent-blue:#0055ff}')
		const response = await get()
		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe('text/css; charset=utf-8')
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
		expect(await response.text()).toBe(':root {\n  --color-accent-blue: #0055ff;\n}\n')
	})

	test('no theme file is an empty stylesheet; an unknown session is 404', async () => {
		const { get } = setup()
		expect(await (await get()).text()).toBe('')
		expect((await get('other')).status).toBe(404)
	})

	test('a theme symlinked out of the project is not read', async () => {
		const { get, projectRoot } = setup()
		const outside = mkdtempSync(join(tmpdir(), 'agent-canvas-theme-outside-'))
		directories.push(outside)
		writeFileSync(join(outside, 'state.css'), 'private-text { --color-x: red }')
		symlinkSync(join(outside, 'state.css'), join(projectRoot, PROJECT_THEME_PATH))
		const response = await get()
		expect(response.status).toBe(422)
		expect(await response.text()).not.toContain('private-text')
	})

	test('a refused theme is not served and says why', async () => {
		const { get } = setup(':root { --color-bg-base: url(https://example.com/pixel.png); }')
		const response = await get()
		expect(response.status).toBe(422)
		expect(await response.json()).toEqual({ error: expect.stringContaining('--color-bg-base') })
	})
})
