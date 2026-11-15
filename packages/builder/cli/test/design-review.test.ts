import { compileJsx } from '@fabrika/canvas-kernel/server'
import { afterEach, expect, test } from 'bun:test'
import { readFileSync, symlinkSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import {
	appliedVariant,
	DESIGN_PATH,
	failingPairs,
	readDesign,
	readDesignContrast,
	renderDesignReview,
	summarizeContrast,
} from '../src/design-review'
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
	expect(summarizeContrast(good)).toBe('contrast: 53 pass, 0 below AA, 3 below AA in the kit itself')

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
	const view = renderDesignReview(readDesign(fx.root), ['/cart?a="b"', '/'], true, new Date('2026-01-01T00:00:00.000Z'))
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
	expect(stderr).toContain('contrast: 49 pass, 4 below AA, 3 below AA in the kit itself')
	expect(stderr).toContain('below AA: light: --fui-text-muted on --fui-surface is 2.')
	const view = readFileSync(join(fx.root, '.fabrika/build/design-review.jsx'), 'utf8')
	expect(view).toContain('BELOW AA')
	expect(view).toContain('/cart')
})

test('--waive-contrast is refused on an issue without the contrast check', async () => {
	fx = makeFixture()
	fx.write('.fabrika/issues/ISSUE-101.md', '---\ngoal: Feature\nsatisfies: []\ndepends_on: []\ntouches: []\nverify: []\n---\nbody\n')
	const proc = Bun.spawn([process.execPath, BIN, 'build', 'done', 'ISSUE-101', '--waive-contrast', '--dir', fx.root], {
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const stderr = await new Response(proc.stderr).text()
	expect(await proc.exited).toBe(1)
	expect(stderr).toContain('--waive-contrast applies only to the "design-checkpoint" gate')
})

test('variants are compared side by side, with swatches, contrast and a required choice', async () => {
	fx = makeFixture()
	withKit(fx)
	const warm = ':root { --fui-accent: #a0522d; }'
	fx.write('web/src/themes/warm.css', warm)
	fx.write('web/src/themes/calm.css', ':root { --fui-accent: #f4a460; }')
	fx.write('web/src/theme.css', warm)
	fx.write(DESIGN_PATH, `---\nstylesheet: web/src/theme.css\nvariants: [web/src/themes/warm.css, web/src/themes/calm.css]\n---\n# Design\n`)

	const design = readDesign(fx.root)
	expect(design.problems).toEqual([])
	expect(design.variants.map((v) => [v.name, failingPairs(v.contrast).length])).toEqual([['warm', 0], ['calm', 4]])
	expect(appliedVariant(design)).toBe('warm')
	const first = design.variants[0]?.contrast
	expect(first?.kind === 'checked' && first.swatches.light.find(([token]) => token === '--fui-accent')).toEqual(['--fui-accent', '#a0522d'])

	const view = renderDesignReview(design, ['/'], true, new Date('2026-01-01T00:00:00.000Z'))
	expect(view).toContain(
		'<Choice id="variant" label="Which variant? (the closest one when requesting changes)" required options={["warm", "calm"]} />',
	)
	expect(view).toContain('badge={"4 below AA"} badgeVariant="warning"')
	const compiled = await compileJsx(view, { projectRoot: fx.root, tempDir: fx.root })
	expect(compiled.ok).toBe(true)

	fx.write('web/src/theme.css', ':root { --fui-accent: #123456; }')
	expect(appliedVariant(readDesign(fx.root))).toBeNull()
})

test('a single variant is a problem, shown and warned, and asks for no choice', () => {
	fx = makeFixture()
	withKit(fx)
	fx.write('web/src/theme.css', ':root { --fui-accent: #a0522d; }')
	fx.write(DESIGN_PATH, `---\nstylesheet: web/src/theme.css\nvariants: [web/src/theme.css]\n---\n# Design\n`)
	const design = readDesign(fx.root)
	expect(design.problems).toEqual(['list two or three `variants:` to compare, not 1'])
	const view = renderDesignReview(design, [], true, new Date('2026-01-01T00:00:00.000Z'))
	expect(view).not.toContain('id="variant"')
})

test('the applied stylesheet matches a variant on the kit tokens alone, whatever else it declares', () => {
	fx = makeFixture()
	withKit(fx)
	fx.write('web/src/themes/warm.css', ':root { --fui-accent: #a0522d; }')
	fx.write('web/src/themes/calm.css', ':root { --fui-accent: #2f6f4f; }')
	fx.write('web/src/theme.css', ':root { --fui-accent: #A0522D; --app-header-height: 3rem; }')
	fx.write(DESIGN_PATH, `---\nstylesheet: web/src/theme.css\nvariants: [web/src/themes/warm.css, web/src/themes/calm.css]\n---\n`)
	const design = readDesign(fx.root)
	expect(appliedVariant(design)).toBe('warm')
	const calm = design.variants[1]?.contrast
	expect(calm?.kind === 'checked' && calm.swatches.dark.find(([token]) => token === '--fui-accent')).toEqual(['--fui-accent', '#7390f0'])
})

test('an unreadable variant and a block-style list are problems; an unreadable variant is never offered', () => {
	fx = makeFixture()
	withKit(fx)
	fx.write('web/src/theme.css', ':root { --fui-accent: #a0522d; }')
	fx.write('web/src/themes/warm.css', ':root { --fui-accent: #a0522d; }')
	fx.write('web/src/themes/calm.css', ':root { --fui-accent: #2f6f4f; }')
	fx.write(DESIGN_PATH, `---\nstylesheet: web/src/theme.css\nvariants: [web/src/themes/warm.css, web/src/themes/calm.css, ../outside.css]\n---\n`)
	const design = readDesign(fx.root)
	expect(design.problems).toEqual(['stylesheet ../outside.css is not a file inside the repository; it is not offered as a choice'])
	expect(renderDesignReview(design, [], true, new Date(0))).toContain('options={["warm", "calm"]}')

	fx.write(DESIGN_PATH, `---\nstylesheet: web/src/theme.css\nvariants:\n  - web/src/themes/warm.css\n---\n`)
	expect(readDesign(fx.root).problems).toEqual(['write `variants` on one line, as `[a.css, b.css]`'])
})

test('a swatch of a token also declared in a rule the check does not read is not computed', () => {
	fx = makeFixture()
	withKit(fx)
	fx.write('web/src/theme.css', '@media (min-width: 1px) { :root { --fui-accent: #000; } } :root { --fui-accent: #a0522d; }')
	fx.write(DESIGN_PATH, `---\nstylesheet: web/src/theme.css\n---\n`)
	const applied = readDesign(fx.root).applied
	expect(applied.kind === 'checked' && applied.swatches.light.find(([token]) => token === '--fui-accent')).toEqual(['--fui-accent', null])
})
