import { compileJsx } from '@fabrika/canvas-kernel/server'
import { afterEach, expect, test } from 'bun:test'
import { readFileSync, symlinkSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { DESIGN_PATH, failingPairs, readDesignContrast, renderDesignReview, summarizeContrast } from '../src/design-review'
import { type Fixture, makeFixture } from './helpers'

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

let fx: Fixture | null = null
afterEach(() => fx?.cleanup())

const KIT_THEME = readFileSync(join(import.meta.dir, '../../../ui/src/theme.css'), 'utf8')

/** A fixture whose `web/` resolves `@fabrika/ui/theme.css` to the kit's real tokens, as an installed SPA does. */
function withKit(f: Fixture): void {
	f.write('web/node_modules/@fabrika/ui/package.json', JSON.stringify({ name: '@fabrika/ui', exports: { './theme.css': './src/theme.css' } }))
	f.write('web/node_modules/@fabrika/ui/src/theme.css', KIT_THEME)
}

const design = (stylesheet: string) => `---\nstylesheet: ${stylesheet}\n---\n# Design\n\nWarm accent.\n`

test('design.md must name a stylesheet inside the repository', () => {
	fx = makeFixture()
	expect(readDesignContrast(fx.root)).toEqual({ kind: 'invalid', problem: `${DESIGN_PATH} is missing` })
	fx.write(DESIGN_PATH, '# Design\n')
	expect(readDesignContrast(fx.root)).toMatchObject({ kind: 'invalid', problem: expect.stringContaining('names no `stylesheet:`') })
	fx.write(DESIGN_PATH, design('../outside.css'))
	expect(readDesignContrast(fx.root)).toMatchObject({ kind: 'invalid', problem: expect.stringContaining('not a file inside the repository') })
	symlinkSync('/etc', join(fx.root, 'linked'))
	fx.write(DESIGN_PATH, design('linked/hostname'))
	expect(readDesignContrast(fx.root).kind).toBe('invalid')
})

test('a stylesheet without the kit is not checked; with it, its overrides are judged over the kit', () => {
	fx = makeFixture()
	fx.write('other/theme.css', ':root { --fui-text: #ccc; }')
	fx.write(DESIGN_PATH, design('other/theme.css'))
	const noKit = readDesignContrast(fx.root)
	expect(noKit.kind).toBe('no-kit')
	expect(failingPairs(noKit)).toEqual([])

	withKit(fx)
	fx.write('web/src/theme.css', "@import '@fabrika/ui/styles.css';\n:root { --fui-accent: #a0522d; }\n")
	fx.write(DESIGN_PATH, design('web/src/theme.css'))
	const good = readDesignContrast(fx.root)
	expect(good).toMatchObject({ kind: 'checked', stylesheet: 'web/src/theme.css', overrides: [['--fui-accent', '#a0522d', '']] })
	expect(failingPairs(good)).toEqual([])
	expect(summarizeContrast(good)).toBe('contrast: 34 pass, 0 below AA, 2 below AA in the kit itself')

	fx.write('web/src/theme.css', ':root { --fui-accent: #f4a460; }')
	const bad = readDesignContrast(fx.root)
	expect(failingPairs(bad).map((r) => `${r.fg}/${r.bg}`)).toEqual([
		'--fui-accent/--fui-bg',
		'--fui-accent/--fui-surface',
		'--fui-accent/--fui-accent-soft',
		'--fui-accent-contrast/--fui-accent',
	])
})

test('the generated view keeps repository text as text for the canvas compiler', async () => {
	fx = makeFixture()
	withKit(fx)
	fx.write('web/src/theme.css', ':root { --fui-surface: color-mix(in srgb, "}export default function X(){}" 50%, white); --x: </Section>; }')
	fx.write(DESIGN_PATH, design('web/src/theme.css'))
	const view = renderDesignReview(readDesignContrast(fx.root), ['/cart?a="b"', '/'], true, new Date('2026-01-01T00:00:00.000Z'))
	expect(view).not.toContain('export default function X')
	expect(view).toContain(`<Markdown file="${DESIGN_PATH}" />`)
	const compiled = await compileJsx(view, { projectRoot: fx.root, tempDir: fx.root })
	expect(compiled.ok).toBe(true)
})

test('design review writes the view and names every pair below AA', async () => {
	fx = makeFixture()
	withKit(fx)
	fx.write('web/src/theme.css', ':root { --fui-text-muted: #9aa0aa; }')
	fx.write(DESIGN_PATH, design('web/src/theme.css'))
	fx.write('tests/browser/cart.test.ts', "browserTest('checkout', { url: '/cart', seeds: [], roles: [] }, async () => {})\n")
	const proc = Bun.spawn([process.execPath, BIN, 'design', 'review', '--dir', fx.root], { stdout: 'pipe', stderr: 'pipe' })
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
	expect(await proc.exited).toBe(0)
	expect(stdout.trim()).toBe(join(fx.root, '.fabrika/build/design-review.jsx'))
	expect(stderr).toContain('contrast: 31 pass, 3 below AA, 2 below AA in the kit itself')
	expect(stderr).toContain('below AA: light: --fui-text-muted on --fui-surface is 2.')
	const view = readFileSync(join(fx.root, '.fabrika/build/design-review.jsx'), 'utf8')
	expect(view).toContain('BELOW AA')
	expect(view).toContain('/cart')
})
