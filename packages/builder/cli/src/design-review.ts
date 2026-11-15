import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { GATE_APPROVE, GATE_CHANGES, GATE_VERDICT_ID } from '../../shared/gate'
import { literal } from './build-review'
import { checkContrast, contrastRatio, type ContrastResult, formatRatio, parseColor, readThemeBlocks, type ThemeMode, tokenHex } from './contrast'
import { extractFrontMatter, list, scalar } from './frontmatter'

// Not `design`: that label belongs to the removed design phase, whose old reviews must not count here.
export const DESIGN_GATE = 'design-checkpoint'
export const DESIGN_PATH = '.fabrika/architecture/design.md'
export const DESIGN_REVIEW_PATH = '.fabrika/build/design-review.jsx'

export type DesignContrast =
	| { kind: 'checked'; stylesheet: string; overrides: string[][]; results: ContrastResult[]; swatches: Swatches }
	/** The stylesheet's directory does not resolve `@fabrika/ui`: a stack without the kit has other tokens. */
	| { kind: 'no-kit'; stylesheet: string }
	| { kind: 'invalid'; problem: string }

/** The colour each swatch token computes to, per mode; null when it cannot be computed. */
type Swatches = Record<ThemeMode, [string, string | null][]>

/** The tokens a variant's swatches show: the page, the text, the accent and its text, focus, danger. */
const SWATCH_TOKENS = [
	'--fui-bg',
	'--fui-surface',
	'--fui-text',
	'--fui-text-muted',
	'--fui-accent',
	'--fui-accent-contrast',
	'--fui-focus',
	'--fui-danger',
]

export interface ThemeVariant {
	/** The file name without its extension: what the reviewer picks. */
	name: string
	contrast: DesignContrast
}

export interface Design {
	/** The stylesheet the application imports (`stylesheet:`): what `build done` judges. */
	applied: DesignContrast
	/** The alternatives the reviewer compares (`variants:`); empty when design.md lists none. */
	variants: ThemeVariant[]
	/** What is wrong with the variant list; shown in the view and warned, never refused. */
	problems: string[]
}

/** The theme override that `design.md`'s front matter names (`stylesheet:`), checked against the kit it imports. */
export function readDesignContrast(repoRoot: string): DesignContrast {
	return readDesign(repoRoot).applied
}

export function readDesign(repoRoot: string): Design {
	const designFile = join(repoRoot, DESIGN_PATH)
	if (!existsSync(designFile)) return { applied: { kind: 'invalid', problem: `${DESIGN_PATH} is missing` }, variants: [], problems: [] }
	const front = extractFrontMatter(readFileSync(designFile, 'utf8')).body
	const stylesheet = scalar(front['stylesheet'])
	const applied: DesignContrast = stylesheet
		? readStylesheet(repoRoot, stylesheet)
		: { kind: 'invalid', problem: `${DESIGN_PATH} names no \`stylesheet:\` in its front matter` }
	const paths = list(front['variants'])
	const variants = paths.map((path) => ({ name: basename(path).replace(/\.[^.]*$/, ''), contrast: readStylesheet(repoRoot, path) }))
	const problems: string[] = []
	if (front['variants'] !== undefined && paths.length === 0) problems.push('write `variants` on one line, as `[a.css, b.css]`')
	if (paths.length === 1 || paths.length > 3) problems.push(`list two or three \`variants:\` to compare, not ${paths.length}`)
	for (const v of variants) if (v.contrast.kind === 'invalid') problems.push(`${v.contrast.problem}; it is not offered as a choice`)
	const names = variants.map((v) => v.name)
	if (new Set(names).size !== names.length) problems.push('two variants share a file name; the reviewer could not tell them apart')
	return { applied, variants, problems }
}

function readStylesheet(repoRoot: string, stylesheet: string): DesignContrast {
	const file = insideRepository(repoRoot, stylesheet)
	if (!file) return { kind: 'invalid', problem: `stylesheet ${stylesheet} is not a file inside the repository` }
	let kitFile: string
	try {
		kitFile = Bun.resolveSync('@fabrika/ui/theme.css', dirname(file))
	} catch {
		return { kind: 'no-kit', stylesheet }
	}
	const app = readThemeBlocks(readFileSync(file, 'utf8'))
	const kit = readThemeBlocks(readFileSync(kitFile, 'utf8'))
	const names = [...new Set([...Object.keys(app.light), ...Object.keys(app.dark)])].sort()
	const shown = (d: { value: string; important: boolean } | undefined) => (d ? `${d.value}${d.important ? ' !important' : ''}` : '')
	const overrides = names.map((name) => [name, shown(app.light[name]), shown(app.dark[name])])
	const swatch = (mode: ThemeMode) => SWATCH_TOKENS.map((t): [string, string | null] => [t, tokenHex(kit, app, mode, t)])
	return { kind: 'checked', stylesheet, overrides, results: checkContrast(kit, app), swatches: { light: swatch('light'), dark: swatch('dark') } }
}

/**
 * The variant whose `--fui-*` overrides the applied stylesheet declares exactly, or null. Only the kit's tokens count:
 * the applied stylesheet also holds the application's own properties. Values compare without case or extra spaces.
 */
export function appliedVariant(design: Design): string | null {
	const { applied } = design
	if (applied.kind !== 'checked') return null
	const tokens = (overrides: string[][]) =>
		JSON.stringify(overrides.filter(([name]) => name?.startsWith('--fui-')).map((row) => row.map((cell) => cell.toLowerCase().replace(/\s+/g, ' '))))
	const same = design.variants.find((v) => v.contrast.kind === 'checked' && tokens(v.contrast.overrides) === tokens(applied.overrides))
	return same?.name ?? null
}

/** The real path of a repository-relative file, or null when it is missing, not a file, or resolves outside. */
function insideRepository(repoRoot: string, path: string): string | null {
	const target = resolve(repoRoot, path)
	if (!existsSync(target)) return null
	const real = realpathSync(target)
	const rel = relative(realpathSync(repoRoot), real)
	if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !statSync(real).isFile()) return null
	return real
}

export function failingPairs(contrast: DesignContrast): ContrastResult[] {
	return contrast.kind === 'checked' ? contrast.results.filter((r) => r.status === 'fail') : []
}

export function describePair(r: ContrastResult): string {
	const ratio = r.ratio === null ? 'not computed' : formatRatio(r.ratio)
	const line = `${r.mode}: ${r.fg} on ${r.bg} is ${ratio}, needs ${r.min}:1`
	// A pair the kit already leaves below AA fails once the override lowers it further: name what to raise.
	if (r.status === 'fail' && r.kitRatio !== null && r.kitRatio < r.min) {
		return `${line}; the kit's own values give ${formatRatio(r.kitRatio)} and the override lowers it, so raise ${r.fg} as well`
	}
	return line
}

/** One line for the build evidence and the console. */
export function summarizeContrast(contrast: DesignContrast): string {
	if (contrast.kind === 'invalid') return `contrast not checked: ${contrast.problem}`
	if (contrast.kind === 'no-kit') return `contrast not checked: @fabrika/ui does not resolve from ${contrast.stylesheet}`
	const count = (status: ContrastResult['status']) => contrast.results.filter((r) => r.status === status).length
	const parts = [`${count('pass')} pass`, `${count('fail')} below AA`]
	if (count('inherited') > 0) parts.push(`${count('inherited')} below AA in the kit itself`)
	if (count('unchecked') > 0) parts.push(`${count('unchecked')} not checked`)
	return `contrast: ${parts.join(', ')}`
}

export const VARIANT_CHOICE_ID = 'variant'

/**
 * The design checkpoint's view: generated, like the build review, so the reviewer sees computed ratios, not claimed ones.
 * With variants, each is shown side by side with a required choice; the preview shows only the applied stylesheet.
 * `withDesign`: `design.md` exists, so the view shows the recorded decisions beside the computed values.
 */
export function renderDesignReview(design: Design, urls: string[], withDesign: boolean, now: Date): string {
	const { applied, variants } = design
	const lines = [
		`<Section title="Design checkpoint — theme of the running app">`,
		`\t<Note>{${literal(note(applied, now))}}</Note>`,
	]
	if (withDesign) lines.push(`\t<Markdown file="${DESIGN_PATH}" />`)
	if (applied.kind === 'checked') {
		lines.push(
			`\t<Table headers={${literal(['Token', 'Light', 'Dark'])}} rows={${literal(applied.overrides)}} />`,
			`\t<Table headers={${literal(['Mode', 'Text or indicator', 'On', 'Ratio', 'Needs', 'Result'])}} rows={${
				literal(contrastRows(applied.results))
			}} />`,
		)
	}
	if (variants.length > 0) {
		const current = appliedVariant(design)
		const where = applied.kind === 'checked' ? applied.stylesheet : 'the applied stylesheet'
		lines.push(
			`\t<Note>{${
				literal(
					current
						? `The preview shows ${where}, which declares the overrides of variant ${current}.`
						: `The preview shows ${where}, which matches none of the variants below.`,
				)
			}}</Note>`,
		)
		variants.forEach((variant, i) => lines.push(...variantItem(variant, i)))
	}
	for (const problem of design.problems) lines.push(`\t<Note>{${literal(`Variants: ${problem}.`)}}</Note>`)
	lines.push(
		`\t<Table headers={${literal(['Route to open in the preview'])}} rows={${
			literal(urls.length ? urls.map((u) => [u]) : [['(no skeleton declares a url)']])
		}} />`,
		`\t<UserInput id="design-note" label="Which screen or token should change?" placeholder="e.g. the price is hard to read on /cart" multiline />`,
	)
	const offered = variants.filter((v) => v.contrast.kind !== 'invalid').map((v) => v.name)
	if (offered.length >= 2) {
		lines.push(
			`\t<Choice id="${VARIANT_CHOICE_ID}" label="Which variant? (the closest one when requesting changes)" required options={${literal(offered)}} />`,
		)
	}
	lines.push(`\t<Choice id="${GATE_VERDICT_ID}" label="Verdict" required options={['${GATE_APPROVE}', '${GATE_CHANGES}']} />`, '</Section>')
	return lines.join('\n') + '\n'
}

function contrastRows(results: ContrastResult[]): string[][] {
	return results.map((r) => [r.mode, r.fg, r.bg, r.ratio === null ? '-' : formatRatio(r.ratio), `${r.min}:1`, result(r)])
}

function variantItem(variant: ThemeVariant, index: number): string[] {
	const { contrast } = variant
	const where = contrast.kind === 'invalid' ? '' : ` — ${contrast.stylesheet}`
	const failing = failingPairs(contrast).length
	const badge = contrast.kind === 'checked' ? (failing > 0 ? `${failing} below AA` : 'AA') : 'not checked'
	const badgeVariant = contrast.kind === 'checked' ? (failing > 0 ? 'warning' : 'success') : 'neutral'
	const lines = [
		`\t<Item id="variant-${index}" label={${literal(`Variant ${variant.name}${where}`)}} badge={${literal(badge)}} badgeVariant="${badgeVariant}">`,
	]
	if (contrast.kind === 'checked') {
		const notPassing = contrast.results.filter((r) => r.status !== 'pass')
		lines.push(
			`\t\t<Mermaid>{${literal(swatchMermaid(contrast.swatches))}}</Mermaid>`,
			`\t\t<Table headers={${literal(['Token', 'Light', 'Dark'])}} rows={${literal(contrast.overrides)}} />`,
			notPassing.length > 0
				? `\t\t<Table headers={${literal(['Mode', 'Text or indicator', 'On', 'Ratio', 'Needs', 'Result'])}} rows={${
					literal(contrastRows(notPassing))
				}} />`
				: `\t\t<Note>Every pair meets AA.</Note>`,
		)
	} else {
		lines.push(`\t\t<Note>{${literal(summarizeContrast(contrast))}}</Note>`)
	}
	lines.push('\t</Item>')
	return lines
}

/** Swatches as a Mermaid graph: only token names and colours the check computed reach it, never repository text. */
function swatchMermaid(swatches: Swatches): string {
	const lines = ['flowchart LR']
	const styles: string[] = []
	for (const mode of ['light', 'dark'] satisfies ThemeMode[]) {
		lines.push(`  subgraph ${mode}`)
		swatches[mode].forEach(([token, hex], i) => {
			const id = `${mode}${i}`
			lines.push(`    ${id}["${token} ${hex ?? '(not computed)'}"]`)
			if (hex) styles.push(`  style ${id} fill:${hex},color:${readableOn(hex)},stroke:#888888`)
		})
		lines.push('  end')
	}
	return [...lines, ...styles].join('\n')
}

/** Black or white, whichever reads better on the colour. */
function readableOn(hex: string): string {
	const bg = parseColor(hex)
	const black = parseColor('#000000')
	const white = parseColor('#ffffff')
	if (!bg || !black || !white) return '#000000'
	return contrastRatio(black, bg) >= contrastRatio(white, bg) ? '#000000' : '#ffffff'
}

function result(r: ContrastResult): string {
	if (r.status === 'pass') return 'pass'
	if (r.status === 'fail') return 'BELOW AA'
	if (r.status === 'inherited') return 'below AA in the kit itself'
	return `not checked: ${r.note ?? ''}`
}

function note(contrast: DesignContrast, now: Date): string {
	const source = `Generated by \`fabrika builder design review\` at ${now.toISOString()}. Open each route in the preview pane.`
	if (contrast.kind === 'checked') {
		return `${source} The ratios are WCAG 2 contrast, computed from the --fui-* tokens of ${contrast.stylesheet} over the kit's own; \`build done\` refuses a pair below AA unless the reviewer waives it.`
	}
	return `${source} ${summarizeContrast(contrast)}.`
}
