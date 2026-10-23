/**
 * The stylesheet of fabrika's own pages is written in the console's tokens. It cannot read them (it loads nothing),
 * so it repeats them, and the copies drifted twice before they were one file. This reads the console's stylesheet,
 * resolves each token the pages use, `light-dark()`, `var()` and the console's `color-mix()` included, and compares.
 */

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { PAGE_STYLE, pageBody } from '../page-style'

const CONSOLE = await Bun.file(join(import.meta.dir, '../../../dashboard/src/styles.css')).text()

/** The page token and the console token it repeats. */
const MIRRORED: [page: string, console: string][] = [
	['floor', 'floor'],
	['logo', 'rail-logo'],
	['art-rule', 'rail-rule'],
	['recess', 'recess'],
	['rule', 'rule'],
	['rule-strong', 'rule-strong'],
	['control', 'control'],
	['control-rule', 'control-rule'],
	['control-hover', 'control-hover'],
	['ink', 'ink'],
	['ink-2', 'ink-2'],
	['ink-3', 'ink-3'],
	['ink-4', 'ink-4'],
	['brand', 'brand'],
	['brand-hover', 'brand-hover'],
	['brand-on', 'brand-on'],
	['blueprint', 'blueprint'],
	['blueprint-hover', 'blueprint-hover'],
	['blueprint-wash', 'blueprint-wash'],
	['rule-focus', 'rule-focus'],
	['lamp-stop', 'lamp-stop'],
	['wash-stop', 'wash-stop'],
]

type Rgba = [number, number, number, number]

function declarations(block: string): Map<string, string> {
	return new Map([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name ?? '', (value ?? '').trim()]))
}

function block(source: string, opening: RegExp): string {
	const start = source.search(opening)
	if (start < 0) throw new Error(`no block ${opening}`)
	const open = source.indexOf('{', start)
	let depth = 0
	for (let index = open; index < source.length; index++) {
		if (source[index] === '{') depth++
		if (source[index] === '}' && --depth === 0) return source.slice(open + 1, index)
	}
	throw new Error(`unclosed block ${opening}`)
}

const consoleTokens = declarations(block(CONSOLE, /^:root \{/m))
const pageLight = declarations(block(PAGE_STYLE, /^:root \{/m))
const pageDark = new Map([...pageLight, ...declarations(block(block(PAGE_STYLE, /^@media \(prefers-color-scheme: dark\)/m), /:root \{/))])

/** The argument list of a CSS function call, split at its top-level commas. */
function argumentsOf(value: string, name: string): string[] {
	const inner = value.slice(name.length + 1, -1)
	const parts: string[] = []
	let depth = 0
	let current = ''
	for (const character of inner) {
		if (character === '(') depth++
		if (character === ')') depth--
		if (character === ',' && depth === 0) {
			parts.push(current.trim())
			current = ''
		} else current += character
	}
	parts.push(current.trim())
	return parts
}

/** A console value as one color in one scheme. */
function resolve(value: string, dark: boolean): Rgba {
	const trimmed = value.trim()
	if (trimmed.startsWith('light-dark(')) {
		const [light, darkValue] = argumentsOf(trimmed, 'light-dark')
		return resolve((dark ? darkValue : light) ?? '', dark)
	}
	if (trimmed.startsWith('var(')) {
		const name = trimmed.slice('var(--'.length, -1)
		const referenced = consoleTokens.get(name)
		if (referenced === undefined) throw new Error(`the console has no --${name}`)
		return resolve(referenced, dark)
	}
	if (trimmed.startsWith('color-mix(')) {
		// `color-mix(in srgb, <a> <p>%, <b>)`: the console's only form.
		const [, first, second] = argumentsOf(trimmed, 'color-mix')
		const match = /^(.*)\s+(\d+(?:\.\d+)?)%$/.exec(first ?? '')
		if (match === null) throw new Error(`unread color-mix ${trimmed}`)
		const share = Number(match[2]) / 100
		const a = resolve(match[1] ?? '', dark)
		const b = resolve(second ?? '', dark)
		const alpha = a[3] * share + b[3] * (1 - share)
		// sRGB mixing premultiplies by alpha, so mixing with `transparent` keeps the color and scales its alpha.
		const channel = (index: 0 | 1 | 2) => alpha === 0 ? 0 : (a[index] * a[3] * share + b[index] * b[3] * (1 - share)) / alpha
		return [channel(0), channel(1), channel(2), alpha]
	}
	return parseColor(trimmed)
}

function parseColor(value: string): Rgba {
	if (value === 'black') return [0, 0, 0, 1]
	if (value === 'white') return [255, 255, 255, 1]
	if (value === 'transparent') return [0, 0, 0, 0]
	const hex = /^#([0-9a-f]{6})$/i.exec(value)
	if (hex !== null) {
		const digits = hex[1] ?? ''
		const byte = (offset: number) => Number.parseInt(digits.slice(offset, offset + 2), 16)
		return [byte(0), byte(2), byte(4), 1]
	}
	const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value)
	if (rgba !== null) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])]
	throw new Error(`unread color ${value}`)
}

/** Equal to the rounding a written-out hex or a two-decimal alpha allows. */
function expectSameColor(actual: Rgba, expected: Rgba, label: string): void {
	for (const index of [0, 1, 2]) {
		expect({ label, channel: Math.abs((actual[index] ?? 0) - (expected[index] ?? 0)) <= 1 }).toEqual({ label, channel: true })
	}
	expect({ label, alpha: Math.abs(actual[3] - expected[3]) <= 0.005 }).toEqual({ label, alpha: true })
}

describe("the pages' stylesheet repeats the console's tokens", () => {
	for (const [page, console] of MIRRORED) {
		test(`--${page} is the console's --${console}, in both schemes`, () => {
			const source = consoleTokens.get(console)
			if (source === undefined) throw new Error(`the console has no --${console}`)
			const schemes: [dark: boolean, tokens: Map<string, string>][] = [[false, pageLight], [true, pageDark]]
			for (const [dark, tokens] of schemes) {
				const written = tokens.get(page)
				if (written === undefined) throw new Error(`the pages have no --${page}`)
				expectSameColor(parseColor(written), resolve(source, dark), `--${page} ${dark ? 'dark' : 'light'}`)
			}
		})
	}
})

describe("the pages' stylesheet", () => {
	test('loads nothing', () => {
		expect(PAGE_STYLE).not.toMatch(/url\(|@import/)
	})

	test('holds no `{name}` Caddy would expand as a placeholder', () => {
		expect(PAGE_STYLE).not.toMatch(/\{\S/)
	})
})

describe('the frame every page has', () => {
	test('the content in the panel, the mark on the grid beside it, and the footer under it', () => {
		const body = pageBody('<h1>Title</h1>', { runsOn: 'Runs on', status: 'Status 403' })
		expect(body).toMatch(/^<main>\n<div class="copy">\n<h1>Title<\/h1>\n<\/div>\n<div class="art" aria-hidden="true"><svg /)
		expect(body).toMatch(
			/<\/main>\n<footer class="made-with"><span class="runs-on">Runs on <svg[^>]*>.*?<\/svg> fabrika<\/span><span class="status">Status 403<\/span><\/footer>$/,
		)
	})

	test('a page without a status has only the line that names fabrika', () => {
		expect(pageBody('', { runsOn: 'Běží na platformě' })).toMatch(
			/<footer class="made-with"><span class="runs-on">Běží na platformě <svg[^>]*>.*?<\/svg> fabrika<\/span><\/footer>$/,
		)
	})
})
