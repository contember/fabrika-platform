import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { GATE_APPROVE, GATE_CHANGES, GATE_VERDICT_ID } from '../../shared/gate'
import { literal } from './build-review'
import { checkContrast, type ContrastResult, formatRatio, readThemeBlocks } from './contrast'
import { extractFrontMatter, scalar } from './frontmatter'

// Not `design`: that label belongs to the removed design phase, whose old reviews must not count here.
export const DESIGN_GATE = 'design-checkpoint'
export const DESIGN_PATH = '.fabrika/architecture/design.md'
export const DESIGN_REVIEW_PATH = '.fabrika/build/design-review.jsx'

export type DesignContrast =
	| { kind: 'checked'; stylesheet: string; overrides: string[][]; results: ContrastResult[] }
	/** The stylesheet's directory does not resolve `@fabrika/ui`: a stack without the kit has other tokens. */
	| { kind: 'no-kit'; stylesheet: string }
	| { kind: 'invalid'; problem: string }

/** The theme override that `design.md`'s front matter names (`stylesheet:`), checked against the kit it imports. */
export function readDesignContrast(repoRoot: string): DesignContrast {
	const designFile = join(repoRoot, DESIGN_PATH)
	if (!existsSync(designFile)) return { kind: 'invalid', problem: `${DESIGN_PATH} is missing` }
	const stylesheet = scalar(extractFrontMatter(readFileSync(designFile, 'utf8')).body['stylesheet'])
	if (!stylesheet) return { kind: 'invalid', problem: `${DESIGN_PATH} names no \`stylesheet:\` in its front matter` }
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
	const overrides = names.map((name) => [name, app.light[name] ?? '', app.dark[name] ?? ''])
	return { kind: 'checked', stylesheet, overrides, results: checkContrast(kit, app) }
}

/** The real path of a repository-relative file, or null when it is missing, not a file, or resolves outside. */
function insideRepository(repoRoot: string, path: string): string | null {
	const target = resolve(repoRoot, path)
	if (!existsSync(target)) return null
	const real = realpathSync(target)
	const rel = relative(realpathSync(repoRoot), real)
	if (rel.startsWith('..') || isAbsolute(rel) || !statSync(real).isFile()) return null
	return real
}

export function failingPairs(contrast: DesignContrast): ContrastResult[] {
	return contrast.kind === 'checked' ? contrast.results.filter((r) => r.status === 'fail') : []
}

export function describePair(r: ContrastResult): string {
	const ratio = r.ratio === null ? 'not computed' : formatRatio(r.ratio)
	return `${r.mode}: ${r.fg} on ${r.bg} is ${ratio}, needs ${r.min}:1`
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

/** The design checkpoint's view: generated, like the build review, so the reviewer sees computed ratios, not claimed ones. */
/** `withDesign`: `design.md` exists, so the view shows the recorded decisions beside the computed values. */
export function renderDesignReview(contrast: DesignContrast, urls: string[], withDesign: boolean, now: Date): string {
	const lines = [
		`<Section title="Design checkpoint — theme of the running app">`,
		`\t<Note>{${literal(note(contrast, now))}}</Note>`,
	]
	if (withDesign) lines.push(`\t<Markdown file="${DESIGN_PATH}" />`)
	if (contrast.kind === 'checked') {
		lines.push(
			`\t<Table headers={${literal(['Token', 'Light', 'Dark'])}} rows={${literal(contrast.overrides)}} />`,
			`\t<Table headers={${literal(['Mode', 'Text or indicator', 'On', 'Ratio', 'Needs', 'Result'])}} rows={${
				literal(contrast.results.map((r) => [r.mode, r.fg, r.bg, r.ratio === null ? '-' : formatRatio(r.ratio), `${r.min}:1`, result(r)]))
			}} />`,
		)
	}
	lines.push(
		`\t<Table headers={${literal(['Route to open in the preview'])}} rows={${
			literal(urls.length ? urls.map((u) => [u]) : [['(no skeleton declares a url)']])
		}} />`,
		`\t<UserInput id="design-note" label="Which screen or token should change?" placeholder="e.g. the price is hard to read on /cart" multiline />`,
		`\t<Choice id="${GATE_VERDICT_ID}" label="Verdict" required options={['${GATE_APPROVE}', '${GATE_CHANGES}']} />`,
		'</Section>',
	)
	return lines.join('\n') + '\n'
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
