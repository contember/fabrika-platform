// WCAG 2 contrast of the `@fabrika/ui` token pairs the kit's components draw, under an application's override.

export type ThemeMode = 'light' | 'dark'
type Tokens = Record<string, string>

interface Declared {
	value: string
	important: boolean
}
type Block = Record<string, Declared>

export interface ThemeBlocks {
	/** Top-level `:root` declarations of custom properties. */
	light: Block
	/** Top-level `:root[data-theme='dark']` declarations of custom properties. */
	dark: Block
	/** `--fui-*` names also declared in a rule this reader does not cascade: another selector, or inside an at-rule. */
	elsewhere: string[]
}

interface Pair {
	fg: string
	bg: string
	/** 4.5 for text, 3 for a focus indicator (WCAG 1.4.3 and 1.4.11). */
	min: number
}

/** The foreground/background pairs `components.css` draws. */
const PAIRS: readonly Pair[] = [
	{ fg: '--fui-text', bg: '--fui-bg', min: 4.5 },
	{ fg: '--fui-text', bg: '--fui-surface', min: 4.5 },
	{ fg: '--fui-text', bg: '--fui-surface-muted', min: 4.5 },
	{ fg: '--fui-text', bg: '--fui-border', min: 4.5 },
	{ fg: '--fui-text', bg: '--fui-accent-soft', min: 4.5 },
	{ fg: '--fui-text-muted', bg: '--fui-bg', min: 4.5 },
	{ fg: '--fui-text-muted', bg: '--fui-surface', min: 4.5 },
	{ fg: '--fui-text-muted', bg: '--fui-surface-muted', min: 4.5 },
	{ fg: '--fui-text-subtle', bg: '--fui-bg', min: 4.5 },
	{ fg: '--fui-text-subtle', bg: '--fui-surface', min: 4.5 },
	{ fg: '--fui-label-color', bg: '--fui-bg', min: 4.5 },
	{ fg: '--fui-label-color', bg: '--fui-surface', min: 4.5 },
	{ fg: '--fui-table-head-color', bg: '--fui-surface-muted', min: 4.5 },
	{ fg: '--fui-accent', bg: '--fui-bg', min: 4.5 },
	{ fg: '--fui-accent', bg: '--fui-surface', min: 4.5 },
	{ fg: '--fui-accent', bg: '--fui-accent-soft', min: 4.5 },
	{ fg: '--fui-accent-contrast', bg: '--fui-accent', min: 4.5 },
	{ fg: '--fui-accent-contrast', bg: '--fui-accent-hover', min: 4.5 },
	{ fg: '--fui-accent-contrast', bg: '--fui-danger', min: 4.5 },
	{ fg: '--fui-accent-contrast', bg: '--fui-danger-text', min: 4.5 },
	{ fg: '--fui-danger-text', bg: '--fui-surface', min: 4.5 },
	{ fg: '--fui-success-text', bg: '--fui-success-soft', min: 4.5 },
	{ fg: '--fui-warning-text', bg: '--fui-warning-soft', min: 4.5 },
	{ fg: '--fui-danger-text', bg: '--fui-danger-soft', min: 4.5 },
	{ fg: '--fui-info-text', bg: '--fui-info-soft', min: 4.5 },
	{ fg: '--fui-focus', bg: '--fui-bg', min: 3 },
	{ fg: '--fui-focus', bg: '--fui-surface', min: 3 },
	{ fg: '--fui-focus', bg: '--fui-surface-muted', min: 3 },
]

export interface ContrastResult {
	fg: string
	bg: string
	mode: ThemeMode
	min: number
	/** Null when either colour could not be computed (`note` says why). */
	ratio: number | null
	/** The same pair with the kit's own values; null when it cannot be computed. */
	kitRatio: number | null
	/**
	 * `inherited`: below the minimum with the kit's own values too, and the override does not lower it — the kit's
	 * defect, not the application's. Only `fail` is the override's.
	 */
	status: 'pass' | 'fail' | 'inherited' | 'unchecked'
	note?: string
}

const LIGHT_SELECTOR = ':root'
// Quotes removed: `[data-theme=dark]` and `[data-theme="dark"]` are the same selector.
const DARK_SELECTOR = ':root[data-theme=dark]'
const FUI_DECLARATION = /(--fui-[\w-]+)\s*:/g

/**
 * Reads the custom properties of the top-level `:root` and `:root[data-theme='dark']` rules, the two blocks the kit
 * declares its tokens in. A `--fui-*` token declared anywhere else is listed in `elsewhere`, so no pair that reads it
 * passes on values the browser may not use.
 */
export function readThemeBlocks(css: string): ThemeBlocks {
	const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
	const light: Block = {}
	const dark: Block = {}
	const read = new Map<string, number>()
	let depth = 0
	let start = 0
	let bodyStart = 0
	let selector = ''
	for (let i = 0; i < src.length; i++) {
		const ch = src.charAt(i)
		if (ch === '{') {
			if (depth === 0) {
				selector = src.slice(start, i)
				bodyStart = i + 1
			}
			depth++
		} else if (ch === '}') {
			depth--
			if (depth === 0) {
				const selectors = selector.split(',').map((s) => s.replace(/\s+/g, '').replace(/["']/g, ''))
				const targets = [selectors.includes(LIGHT_SELECTOR) ? light : null, selectors.includes(DARK_SELECTOR) ? dark : null]
				const body = src.slice(bodyStart, i)
				if (targets.some((t) => t !== null) && !body.includes('{')) {
					const declared = declarations(body)
					for (const target of targets) if (target) Object.assign(target, declared)
					for (const name of Object.keys(declared)) read.set(name, (read.get(name) ?? 0) + 1)
				}
				start = i + 1
			}
			if (depth < 0) depth = 0
		} else if (ch === ';' && depth === 0) {
			start = i + 1
		}
	}
	const total = new Map<string, number>()
	for (const m of src.matchAll(FUI_DECLARATION)) total.set(m[1] ?? '', (total.get(m[1] ?? '') ?? 0) + 1)
	const elsewhere = [...total].filter(([name, count]) => count > (read.get(name) ?? 0)).map(([name]) => name)
	return { light, dark, elsewhere }
}

function declarations(body: string): Block {
	const out: Block = {}
	for (const decl of body.split(';')) {
		const colon = decl.indexOf(':')
		if (colon < 0) continue
		const name = decl.slice(0, colon).trim()
		if (!name.startsWith('--')) continue
		const raw = decl.slice(colon + 1).trim()
		const important = /!\s*important$/i.test(raw)
		out[name] = { value: important ? raw.replace(/!\s*important$/i, '').trim() : raw, important }
	}
	return out
}

/**
 * The token values each mode computes to with the application's stylesheet imported after the kit's. The dark rule is
 * more specific than `:root`, so an application's `:root` override reaches dark mode only where the kit's dark rule
 * declares nothing, or with `!important`, which outranks every normal declaration.
 */
export function cascade(kit: ThemeBlocks, app: ThemeBlocks): Record<ThemeMode, Tokens> {
	const light = [kit.light, app.light]
	const dark = [kit.light, app.light, kit.dark, app.dark]
	return { light: layered(light), dark: layered(dark) }
}

/** Blocks in ascending precedence: normal declarations first, then the important ones in the same order. */
function layered(blocks: Block[]): Tokens {
	const out: Tokens = {}
	for (const important of [false, true]) {
		for (const block of blocks) {
			for (const [name, d] of Object.entries(block)) if (d.important === important) out[name] = d.value
		}
	}
	return out
}

export function checkContrast(kit: ThemeBlocks, app: ThemeBlocks): ContrastResult[] {
	const themed = cascade(kit, app)
	const baseline = cascade(kit, { light: {}, dark: {}, elsewhere: [] })
	const elsewhere = new Set(app.elsewhere)
	const modes: ThemeMode[] = ['light', 'dark']
	return modes.flatMap((mode) =>
		PAIRS.map((pair): ContrastResult => {
			const kitMeasured = pairRatio(baseline[mode], pair, new Set())
			const kitRatio = typeof kitMeasured === 'number' ? kitMeasured : null
			const base = { fg: pair.fg, bg: pair.bg, mode, min: pair.min, kitRatio }
			const measured = pairRatio(themed[mode], pair, elsewhere)
			if (typeof measured === 'string') return { ...base, ratio: null, status: 'unchecked', note: measured }
			if (measured >= pair.min) return { ...base, ratio: measured, status: 'pass' }
			const inherited = kitRatio !== null && kitRatio < pair.min && measured >= kitRatio
			return { ...base, ratio: measured, status: inherited ? 'inherited' : 'fail' }
		})
	)
}

/** The ratio, or why it cannot be computed. */
function pairRatio(tokens: Tokens, pair: Pair, elsewhere: Set<string>): number | string {
	const fg = tokenColor(tokens, pair.fg, elsewhere)
	if (typeof fg === 'string') return fg
	const bg = tokenColor(tokens, pair.bg, elsewhere)
	if (typeof bg === 'string') return bg
	if (bg.a < 1) return `${pair.bg} is translucent`
	return contrastRatio(over(fg, bg), bg)
}

function tokenColor(tokens: Tokens, name: string, elsewhere: Set<string>): Rgba | string {
	const chain: string[] = []
	const value = resolveVar(tokens, name, chain)
	const unread = chain.find((n) => elsewhere.has(n))
	if (unread) return `${unread} is also declared in a rule the check does not read (another selector, or inside an at-rule)`
	if (value === null) return `${name} is not declared, or its var() chain does not resolve`
	const color = parseColor(value)
	return color ?? `${name} is \`${value}\`, a colour the check does not read`
}

/** Follows a `var()` chain; `chain` collects every token name it read. */
function resolveVar(tokens: Tokens, name: string, chain: string[]): string | null {
	chain.push(name)
	const value = tokens[name]
	if (value === undefined || chain.length > 16) return null
	const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(value)
	if (!ref) return value
	return resolveVar(tokens, ref[1] ?? '', chain) ?? ref[2]?.trim() ?? null
}

/** Encoded sRGB channels and alpha, each in [0, 1]. */
interface Rgba {
	r: number
	g: number
	b: number
	a: number
}

/** OKLCH here; every other CSS colour through `Bun.color`, which does not read OKLCH. Null when neither reads it. */
export function parseColor(value: string): Rgba | null {
	const v = value.trim().toLowerCase()
	const oklch = /^oklch\(([^()]*)\)$/.exec(v)
	if (oklch) return parseOklch(oklch[1] ?? '')
	const rgba = Bun.color(v, '{rgba}')
	return rgba ? { r: rgba.r / 255, g: rgba.g / 255, b: rgba.b / 255, a: rgba.a } : null
}

function parseOklch(args: string): Rgba | null {
	const parts = args.split(/[\s/]+/).filter((p) => p.length > 0)
	if (parts.length !== 3 && parts.length !== 4) return null
	const l = number(parts[0] ?? '', 1)
	// Chroma's 100% is 0.4 (CSS Color 4).
	const c = number(parts[1] ?? '', 0.4)
	const hue = Number((parts[2] ?? '').replace(/deg$/, ''))
	const a = parts[3] === undefined ? 1 : number(parts[3], 1)
	if (l === null || c === null || a === null || !Number.isFinite(hue)) return null
	return { ...oklchToRgb(Math.min(1, Math.max(0, l)), Math.max(0, c), hue), a: Math.min(1, Math.max(0, a)) }
}

/** A plain number, or a percentage of `full`. */
function number(part: string, full: number): number | null {
	const pct = part.endsWith('%')
	const n = Number(pct ? part.slice(0, -1) : part)
	if (!Number.isFinite(n)) return null
	return pct ? (n / 100) * full : n
}

/** OKLCH to encoded sRGB. An out-of-gamut colour is clipped channel by channel, not chroma-reduced as a browser may. */
function oklchToRgb(l: number, c: number, h: number): { r: number; g: number; b: number } {
	const rad = (h * Math.PI) / 180
	const a = c * Math.cos(rad)
	const b = c * Math.sin(rad)
	const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
	const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
	const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
	const encode = (x: number) => {
		const v = Math.min(1, Math.max(0, x))
		return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
	}
	return {
		r: encode(4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp),
		g: encode(-1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp),
		b: encode(-0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp),
	}
}

/** A translucent foreground composited over an opaque background, as the browser paints it. */
function over(fg: Rgba, bg: Rgba): Rgba {
	const mix = (f: number, b: number) => f * fg.a + b * (1 - fg.a)
	return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 }
}

export function contrastRatio(x: Rgba, y: Rgba): number {
	const lx = luminance(x)
	const ly = luminance(y)
	return (Math.max(lx, ly) + 0.05) / (Math.min(lx, ly) + 0.05)
}

function luminance({ r, g, b }: Rgba): number {
	const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** Truncated, never rounded up: WCAG does not round, so 4.499 must not read as 4.50. */
export function formatRatio(ratio: number): string {
	return `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`
}
