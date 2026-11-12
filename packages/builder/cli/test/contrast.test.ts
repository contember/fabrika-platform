import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { checkContrast, type ContrastResult, formatRatio, parseColor, readThemeBlocks } from '../src/contrast'

const KIT = readThemeBlocks(readFileSync(join(import.meta.dir, '../../../ui/src/theme.css'), 'utf8'))
const NO_OVERRIDE = readThemeBlocks('')

function find(results: ContrastResult[], fg: string, bg: string, mode: 'light' | 'dark'): ContrastResult | undefined {
	return results.find((r) => r.fg === fg && r.bg === bg && r.mode === mode)
}

describe('contrast of the kit tokens', () => {
	test("the kit's own values never fail; a pair the kit itself leaves below AA reads as inherited", () => {
		const results = checkContrast(KIT, NO_OVERRIDE)
		expect(results.filter((r) => r.status === 'fail' || r.status === 'unchecked')).toEqual([])
		expect(results.filter((r) => r.status === 'inherited').map((r) => `${r.mode} ${r.fg}/${r.bg}`)).toEqual([
			'light --fui-text-subtle/--fui-bg',
			'light --fui-text-subtle/--fui-surface',
			'dark --fui-accent/--fui-accent-soft',
		])
	})

	test('an override that lowers a text pair fails in the mode it reaches', () => {
		const app = readThemeBlocks(':root { --fui-text-muted: #9aa0aa; }')
		const results = checkContrast(KIT, app)
		const light = find(results, '--fui-text-muted', '--fui-surface', 'light')
		expect(light?.status).toBe('fail')
		expect(light?.ratio).toBeLessThan(4.5)
		// The kit's dark rule is more specific than `:root`, so the override does not reach dark mode.
		expect(find(results, '--fui-text-muted', '--fui-surface', 'dark')?.status).toBe('pass')
	})

	test('a dark override, a var() chain and the CSS colour functions are read', () => {
		const app = readThemeBlocks(`
			/* brand { not a rule } */
			:root, html { --brand: oklch(0.45 0.12 30); --fui-accent: var(--brand); }
			:root[data-theme="dark"] { --fui-surface: hsl(220 20% 12%); --fui-text: rgb(240 240 240 / 100%) !important; }
		`)
		const results = checkContrast(KIT, app)
		expect(find(results, '--fui-accent-contrast', '--fui-accent', 'light')?.status).toBe('pass')
		expect(find(results, '--fui-text', '--fui-surface', 'dark')?.status).toBe('pass')
		// A token the kit's dark rule declares keeps the kit's value in dark mode, whatever `:root` says.
		const kitOnly = find(checkContrast(KIT, NO_OVERRIDE), '--fui-accent', '--fui-bg', 'dark')
		expect(find(results, '--fui-accent', '--fui-bg', 'dark')?.ratio).toBe(kitOnly?.ratio ?? 0)
		expect(find(results, '--fui-accent', '--fui-bg', 'light')?.ratio).not.toBe(
			find(checkContrast(KIT, NO_OVERRIDE), '--fui-accent', '--fui-bg', 'light')?.ratio ?? 0,
		)
	})

	test('a colour the check cannot read is reported unchecked, never passed or failed', () => {
		const results = checkContrast(KIT, readThemeBlocks(':root { --fui-surface: color-mix(in srgb, var(--brand) 90%, black); }'))
		const pair = find(results, '--fui-text', '--fui-surface', 'light')
		expect(pair?.status).toBe('unchecked')
		expect(pair?.note).toContain('color-mix')
	})

	test('a translucent foreground is composited over its background; a translucent background is unchecked', () => {
		const faint = checkContrast(KIT, readThemeBlocks(':root { --fui-text: rgba(27, 31, 39, 0.2); }'))
		expect(find(faint, '--fui-text', '--fui-surface', 'light')?.status).toBe('fail')
		const glass = checkContrast(KIT, readThemeBlocks(':root { --fui-surface: #ffffff80; }'))
		expect(find(glass, '--fui-text', '--fui-surface', 'light')?.status).toBe('unchecked')
	})

	test('a token also declared in a rule the check does not read leaves its pairs unchecked, never passed', () => {
		for (
			const css of [
				'@media (min-width: 1px) { :root { --fui-text: #eee; } }',
				'.fui-app { --fui-text: #eee; }',
				"html[data-theme='dark'] { --fui-text: #222; }",
			]
		) {
			const app = readThemeBlocks(`${css} :root { --fui-bg: #fff; }`)
			expect(app.light).toEqual({ '--fui-bg': { value: '#fff', important: false } })
			expect(app.elsewhere).toEqual(['--fui-text'])
			const pair = find(checkContrast(KIT, app), '--fui-text', '--fui-bg', 'dark')
			expect(pair?.status).toBe('unchecked')
			expect(pair?.note).toContain('--fui-text is also declared in a rule the check does not read')
		}
	})

	test('!important, a selector list and an unquoted attribute reach dark mode as the browser applies them', () => {
		for (
			const css of [
				':root { --fui-text: #222 !important; }',
				":root, :root[data-theme='dark'] { --fui-text: #222; }",
				':root[data-theme=dark] { --fui-text: #222; }',
			]
		) {
			const dark = find(checkContrast(KIT, readThemeBlocks(css)), '--fui-text', '--fui-bg', 'dark')
			expect(dark?.status).toBe('fail')
			expect(dark?.ratio).toBeLessThan(1.5)
		}
	})

	test('an override that lowers a pair the kit already leaves below AA fails, and keeps the kit ratio for the message', () => {
		const pair = find(checkContrast(KIT, readThemeBlocks(':root { --fui-surface: #fbf7f0; }')), '--fui-text-subtle', '--fui-surface', 'light')
		expect(pair?.status).toBe('fail')
		expect(pair?.kitRatio).toBeGreaterThan(pair?.ratio ?? 0)
	})
})

describe('colour parsing', () => {
	test('reads hex, rgb, hsl and oklch to the same white', () => {
		for (const white of ['#fff', '#ffffffff', 'rgb(255, 255, 255)', 'rgb(100% 100% 100%)', 'hsl(0 0% 100%)', 'oklch(1 0 0)']) {
			const c = parseColor(white)
			expect(c?.a).toBe(1)
			expect([c?.r, c?.g, c?.b].map((v) => Math.round((v ?? 0) * 255))).toEqual([255, 255, 255])
		}
		expect(parseColor('white')).toEqual({ r: 1, g: 1, b: 1, a: 1 })
		expect(parseColor('var(--x)')).toBeNull()
	})

	test('reads a chromatic oklch: the CSS Color 4 sRGB red', () => {
		const red = parseColor('oklch(62.8% 0.2577 29.23deg)')
		expect([red?.r, red?.g, red?.b].map((v) => Math.round((v ?? 0) * 255))).toEqual([255, 0, 0])
	})
})

test('a ratio is truncated, never rounded up past the threshold', () => {
	expect(formatRatio(4.4999)).toBe('4.49:1')
	expect(formatRatio(21)).toBe('21.00:1')
})
