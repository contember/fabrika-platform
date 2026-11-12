// WCAG 2 contrast of the `@fabrika/ui` token pairs the kit's components draw, under an application's override.

export type ThemeMode = 'light' | 'dark'
type Tokens = Record<string, string>

export interface ThemeBlocks {
	/** Top-level `:root` declarations of custom properties. */
	light: Tokens
	/** Top-level `:root[data-theme='dark']` declarations of custom properties. */
	dark: Tokens
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
	{ fg: '--fui-text-muted', bg: '--fui-bg', min: 4.5 },
	{ fg: '--fui-text-muted', bg: '--fui-surface', min: 4.5 },
	{ fg: '--fui-text-muted', bg: '--fui-surface-muted', min: 4.5 },
	{ fg: '--fui-text-subtle', bg: '--fui-surface', min: 4.5 },
	{ fg: '--fui-accent', bg: '--fui-bg', min: 4.5 },
	{ fg: '--fui-accent', bg: '--fui-surface', min: 4.5 },
	{ fg: '--fui-accent', bg: '--fui-accent-soft', min: 4.5 },
	{ fg: '--fui-accent-contrast', bg: '--fui-accent', min: 4.5 },
	{ fg: '--fui-accent-contrast', bg: '--fui-accent-hover', min: 4.5 },
	{ fg: '--fui-success-text', bg: '--fui-success-soft', min: 4.5 },
	{ fg: '--fui-warning-text', bg: '--fui-warning-soft', min: 4.5 },
	{ fg: '--fui-danger-text', bg: '--fui-danger-soft', min: 4.5 },
	{ fg: '--fui-info-text', bg: '--fui-info-soft', min: 4.5 },
	{ fg: '--fui-focus', bg: '--fui-bg', min: 3 },
	{ fg: '--fui-focus', bg: '--fui-surface', min: 3 },
]

export interface ContrastResult {
	fg: string
	bg: string
	mode: ThemeMode
	min: number
	/** Null when either colour could not be computed (`note` says why). */
	ratio: number | null
	/**
	 * `inherited`: below the minimum with the kit's own values too, and the override does not lower it — the kit's
	 * defect, not the application's. Only `fail` is the override's.
	 */
	status: 'pass' | 'fail' | 'inherited' | 'unchecked'
	note?: string
}

const DARK_SELECTOR = ":root[data-theme='dark']"

/**
 * Reads the custom properties of the top-level `:root` and `:root[data-theme='dark']` rules, the two blocks the kit
 * declares its tokens in. Rules inside an at-rule (`@media`, `@layer`) and any other selector are not read.
 */
export function readThemeBlocks(css: string): ThemeBlocks {
	const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
	const blocks: ThemeBlocks = { light: {}, dark: {} }
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
				const target = blockFor(selector, blocks)
				if (target) Object.assign(target, declarations(src.slice(bodyStart, i)))
				start = i + 1
			}
			if (depth < 0) depth = 0
		} else if (ch === ';' && depth === 0) {
			start = i + 1
		}
	}
	return blocks
}

function blockFor(selector: string, blocks: ThemeBlocks): Tokens | null {
	const selectors = selector.split(',').map((s) => s.replace(/\s+/g, '').replaceAll('"', "'"))
	if (selectors.includes(':root')) return blocks.light
	if (selectors.includes(DARK_SELECTOR)) return blocks.dark
	return null
}

function declarations(body: string): Tokens {
	const out: Tokens = {}
	for (const decl of body.split(';')) {
		const colon = decl.indexOf(':')
		if (colon < 0) continue
		const name = decl.slice(0, colon).trim()
		if (!name.startsWith('--')) continue
		out[name] = decl.slice(colon + 1).replace(/!important\s*$/i, '').trim()
	}
	return out
}

/**
 * The token values each mode computes to with the application's stylesheet imported after the kit's. The dark rule is
 * more specific than `:root`, so an application's `:root` override reaches dark mode only where the kit's dark rule
 * declares nothing.
 */
export function cascade(kit: ThemeBlocks, app: ThemeBlocks): Record<ThemeMode, Tokens> {
	return {
		light: { ...kit.light, ...app.light },
		dark: { ...kit.light, ...app.light, ...kit.dark, ...app.dark },
	}
}

export function checkContrast(kit: ThemeBlocks, app: ThemeBlocks): ContrastResult[] {
	const themed = cascade(kit, app)
	const baseline = cascade(kit, { light: {}, dark: {} })
	const modes: ThemeMode[] = ['light', 'dark']
	return modes.flatMap((mode) =>
		PAIRS.map((pair): ContrastResult => {
			const measured = pairRatio(themed[mode], pair)
			const base = { fg: pair.fg, bg: pair.bg, mode, min: pair.min }
			if (typeof measured === 'string') return { ...base, ratio: null, status: 'unchecked', note: measured }
			if (measured >= pair.min) return { ...base, ratio: measured, status: 'pass' }
			const kitRatio = pairRatio(baseline[mode], pair)
			const inherited = typeof kitRatio === 'number' && kitRatio < pair.min && measured >= kitRatio
			return { ...base, ratio: measured, status: inherited ? 'inherited' : 'fail' }
		})
	)
}

/** The ratio, or why it cannot be computed. */
function pairRatio(tokens: Tokens, pair: Pair): number | string {
	const fg = tokenColor(tokens, pair.fg)
	if (typeof fg === 'string') return fg
	const bg = tokenColor(tokens, pair.bg)
	if (typeof bg === 'string') return bg
	if (bg.a < 1) return `${pair.bg} is translucent`
	return contrastRatio(over(fg, bg), bg)
}

function tokenColor(tokens: Tokens, name: string): Rgba | string {
	const value = resolveVar(tokens, name, 0)
	if (value === null) return `${name} is not declared, or its var() chain does not resolve`
	const color = parseColor(value)
	return color ?? `${name} is \`${value}\`, a colour syntax the check does not read`
}

function resolveVar(tokens: Tokens, name: string, depth: number): string | null {
	const value = tokens[name]
	if (value === undefined || depth > 16) return null
	const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(value)
	if (!ref) return value
	return resolveVar(tokens, ref[1] ?? '', depth + 1) ?? ref[2]?.trim() ?? null
}

/** Encoded sRGB channels and alpha, each in [0, 1]. */
interface Rgba {
	r: number
	g: number
	b: number
	a: number
}

export function parseColor(value: string): Rgba | null {
	const v = value.trim().toLowerCase()
	if (v.startsWith('#')) return parseHex(v.slice(1))
	const fn = /^(rgba?|hsla?|oklch)\(([^()]*)\)$/.exec(v)
	if (!fn) return null
	const parts = (fn[2] ?? '').split(/[\s,/]+/).filter((p) => p.length > 0)
	if (parts.length !== 3 && parts.length !== 4) return null
	const alpha = parts[3] === undefined ? 1 : unit(parts[3], 1)
	if (alpha === null) return null
	const kind = fn[1] ?? ''
	if (kind.startsWith('rgb')) {
		const [r, g, b] = parts.map((p) => unit(p, 255))
		return r == null || g == null || b == null ? null : { r, g, b, a: alpha }
	}
	if (kind.startsWith('hsl')) {
		const h = degrees(parts[0] ?? '')
		const s = unit(parts[1] ?? '', 100)
		const l = unit(parts[2] ?? '', 100)
		return h === null || s === null || l === null ? null : { ...hslToRgb(h, s, l), a: alpha }
	}
	const l = unit(parts[0] ?? '', 1)
	// Chroma's 100% is 0.4 (CSS Color 4).
	const c = parts[1]?.endsWith('%') ? scaled(unit(parts[1], 1), 0.4) : unit(parts[1] ?? '', 1)
	const h = degrees(parts[2] ?? '')
	return l === null || c === null || h === null ? null : { ...oklchToRgb(l, c, h), a: alpha }
}

function parseHex(hex: string): Rgba | null {
	if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(hex)) return null
	const full = hex.length <= 4 ? [...hex].map((ch) => ch + ch).join('') : hex
	const channel = (i: number) => parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255
	return { r: channel(0), g: channel(1), b: channel(2), a: full.length === 8 ? channel(3) : 1 }
}

/** A number divided by `scale`, or a percentage of 1; clamped to [0, 1]. */
function unit(part: string, scale: number): number | null {
	const pct = part.endsWith('%')
	const n = Number(pct ? part.slice(0, -1) : part)
	if (!Number.isFinite(n)) return null
	return Math.min(1, Math.max(0, pct ? n / 100 : n / scale))
}

function scaled(v: number | null, by: number): number | null {
	return v === null ? null : v * by
}

function degrees(part: string): number | null {
	const n = Number(part.endsWith('deg') ? part.slice(0, -3) : part)
	return Number.isFinite(n) ? ((n % 360) + 360) % 360 : null
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
	const k = (n: number) => (n + h / 30) % 12
	const a = s * Math.min(l, 1 - l)
	const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
	return { r: f(0), g: f(8), b: f(4) }
}

/** OKLCH to encoded sRGB, clamped into gamut channel by channel. */
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
