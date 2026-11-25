// An SPA mount as an installable application (ADR-0087): the web app manifest the framework derives from the contract,
// the icon it draws, and the links it adds to the mount's pages. Everything here is served under the mount's own
// access, like `__fabrika-config.json`; nothing is public and nothing is cached by a service worker. Runtime-neutral:
// the icon is encoded with `CompressionStream`, which Bun and workerd both have.

import { APP_ICON_SIZES, APP_MANIFEST_FILE, appIconFile, type AppIconSize, joinPath } from '../contract/defaults'
import { injectIntoHead } from './html'

/** What the framework knows of an SPA mount to make it installable: all of it from the approved artifact. */
export interface InstallableMount {
	/** The contract's application id. */
	readonly app: string
	/** The contract's `displayName`, when it declares one. */
	readonly displayName: string | undefined
	/** The mount's name in the contract. */
	readonly mount: string
	readonly prefix: string
}

/** The members of a web app manifest the framework writes (W3C Web Application Manifest). */
export interface AppManifest {
	readonly id: string
	readonly name: string
	readonly short_name: string
	readonly start_url: string
	readonly scope: string
	readonly display: 'standalone'
	readonly theme_color: string
	readonly background_color: string
	readonly icons: readonly { readonly src: string; readonly sizes: string; readonly type: 'image/png'; readonly purpose: 'any' | 'maskable' }[]
}

/** A browser shows `short_name` under the icon; past about twelve characters it cuts it itself. */
const SHORT_NAME_LENGTH = 12

/** The mount's own path with its trailing slash: the manifest's scope, start URL and id. */
function scopeOf(prefix: string): string {
	return prefix === '/' ? '/' : `${prefix}/`
}

export function appManifestPath(prefix: string): string {
	return joinPath(prefix, APP_MANIFEST_FILE)
}

export function appIconPath(prefix: string, size: AppIconSize): string {
	return joinPath(prefix, appIconFile(size))
}

/** The name people see: the contract's display name (or its id), and a mount below the root also names itself. */
export function appName(mount: InstallableMount): string {
	const base = mount.displayName ?? mount.app
	return mount.prefix === '/' ? base : `${base} · ${mount.mount}`
}

function shortNameOf(name: string): string {
	const characters = [...name]
	if (characters.length <= SHORT_NAME_LENGTH) return name
	const first = name.split(/\s+/)[0] ?? ''
	return first !== '' && [...first].length <= SHORT_NAME_LENGTH ? first : characters.slice(0, SHORT_NAME_LENGTH).join('').trim()
}

/**
 * The manifest of the mount. Scope and start URL are the mount itself, so the window an installed application opens
 * shows the mount's pages and nothing else of the host; IAM's sign-in on its own origin is out of scope, which a browser
 * shows inside the application's window with its origin named.
 */
export function appManifest(mount: InstallableMount): AppManifest {
	const name = appName(mount)
	const scope = scopeOf(mount.prefix)
	const colour = hexColour(iconColour(mount.app))
	return {
		id: scope,
		name,
		short_name: shortNameOf(name),
		start_url: scope,
		scope,
		display: 'standalone',
		theme_color: colour,
		background_color: colour,
		icons: [
			{ src: appIconPath(mount.prefix, 192), sizes: '192x192', type: 'image/png', purpose: 'any' },
			{ src: appIconPath(mount.prefix, 512), sizes: '512x512', type: 'image/png', purpose: 'any' },
			{ src: appIconPath(mount.prefix, 512), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
		],
	}
}

function escapeAttribute(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/**
 * The tags the mount's pages get: the manifest, fetched with the session (a browser fetches a manifest without
 * credentials unless the link asks for them, even from its own origin), and Apple's touch icon, which Safari reads
 * instead of the manifest's icons.
 */
export function installLinks(prefix: string): string {
	return `<link rel="manifest" href="${escapeAttribute(appManifestPath(prefix))}" crossorigin="use-credentials">`
		+ `<link rel="apple-touch-icon" href="${escapeAttribute(appIconPath(prefix, 180))}">`
}

/** One mount's installable files, drawn once per runtime. */
export class InstallableApp {
	readonly #mount: InstallableMount
	readonly #manifest: string
	readonly #icons = new Map<AppIconSize, Promise<Uint8Array<ArrayBuffer>>>()

	constructor(mount: InstallableMount) {
		this.#mount = mount
		this.#manifest = JSON.stringify(appManifest(mount))
	}

	/** The answer for one of the mount's installable files, or `null` for any other path. */
	file(path: string): Promise<Response> | null {
		if (path === appManifestPath(this.#mount.prefix)) {
			return Promise.resolve(new Response(this.#manifest, { status: 200, headers: { 'Content-Type': 'application/manifest+json' } }))
		}
		const size = APP_ICON_SIZES.find((candidate) => path === appIconPath(this.#mount.prefix, candidate))
		return size === undefined ? null : this.#icon(size)
	}

	/** The mount's page with the install links in its head; any other answer passes unchanged. */
	async page(response: Response): Promise<Response> {
		return await injectIntoHead(response, installLinks(this.#mount.prefix))
	}

	async #icon(size: AppIconSize): Promise<Response> {
		let drawn = this.#icons.get(size)
		if (drawn === undefined) {
			drawn = drawIcon(size, appName(this.#mount), iconColour(this.#mount.app))
			this.#icons.set(size, drawn)
			// A failed draw is not kept, so the next request draws again.
			drawn.catch(() => this.#icons.delete(size))
		}
		return new Response(await drawn, { status: 200, headers: { 'Content-Type': 'image/png' } })
	}
}

// ── The icon ────────────────────────────────────────────────────────────────────────────────────

type Rgb = readonly [number, number, number]

/** A colour per application id, stable across releases: FNV-1a of the id picks the hue, at a fixed saturation and lightness. */
export function iconColour(app: string): Rgb {
	let hash = 0x811c9dc5
	for (const byte of new TextEncoder().encode(app)) {
		hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
	}
	return hslToRgb(hash % 360, 0.55, 0.42)
}

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
	const sector = hue / 60
	const second = chroma * (1 - Math.abs((sector % 2) - 1))
	const [r, g, b] = sector < 1
		? [chroma, second, 0]
		: sector < 2
		? [second, chroma, 0]
		: sector < 3
		? [0, chroma, second]
		: sector < 4
		? [0, second, chroma]
		: sector < 5
		? [second, 0, chroma]
		: [chroma, 0, second]
	const match = lightness - chroma / 2
	return [Math.round((r + match) * 255), Math.round((g + match) * 255), Math.round((b + match) * 255)]
}

function hexColour([r, g, b]: Rgb): string {
	return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/** A 5×7 glyph per letter and digit, one string of five cells per row, `1` drawn. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
	A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
	B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
	C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
	D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
	E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
	F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
	G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
	H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
	I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
	J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
	K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
	L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
	M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
	N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
	O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
	P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
	Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
	R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
	S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
	T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
	U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
	V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
	W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
	X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
	Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
	Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
	'0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
	'1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
	'2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
	'3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
	'4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
	'5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
	'6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
	'7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
	'8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
	'9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
}

/** The glyph of the name's first letter or digit, its diacritics removed; `null` when it has none. */
export function initialOf(name: string): string | null {
	const plain = name.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase()
	for (const character of plain) {
		if (GLYPHS[character] !== undefined) return character
	}
	return null
}

/**
 * The glyph's cell, as a share of the icon's side. Its 5×7 box then spans 37.5 % by 52.5 % of the side, whose corners
 * lie within the circle of 40 % radius that a maskable icon keeps visible under every mask.
 */
const GLYPH_CELL = 0.075

const WHITE: Rgb = [255, 255, 255]

/** The icon: the application's colour edge to edge, its initial in white at the centre, as a PNG. */
export async function drawIcon(size: number, name: string, colour: Rgb): Promise<Uint8Array<ArrayBuffer>> {
	const glyph = initialOf(name)
	const cell = Math.round(size * GLYPH_CELL)
	const left = Math.round((size - 5 * cell) / 2)
	const top = Math.round((size - 7 * cell) / 2)
	const stride = 1 + size * 3
	const raw = new Uint8Array(size * stride)
	for (let y = 0; y < size; y++) {
		const glyphRow = glyph === null ? undefined : GLYPHS[glyph]?.[Math.floor((y - top) / cell)]
		for (let x = 0; x < size; x++) {
			const inside = glyphRow !== undefined && y >= top && x >= left && glyphRow[Math.floor((x - left) / cell)] === '1'
			raw.set(inside ? WHITE : colour, y * stride + 1 + x * 3)
		}
	}
	return await encodePng(size, raw)
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/** A truecolour PNG of `size`×`size` from its filtered scanlines (filter type 0 at the start of each row). */
async function encodePng(size: number, scanlines: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	const header = new Uint8Array(13)
	const view = new DataView(header.buffer)
	view.setUint32(0, size)
	view.setUint32(4, size)
	// Bit depth 8, colour type 2 (RGB), deflate, adaptive filtering, no interlace.
	header.set([8, 2, 0, 0, 0], 8)
	// The Compression Streams `deflate` format is the zlib stream a PNG's IDAT holds.
	const compressed = new Uint8Array(await new Response(new Blob([scanlines]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer())
	const parts = [Uint8Array.from(PNG_SIGNATURE), pngChunk('IHDR', header), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array(0))]
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
	let at = 0
	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}
	return out
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const typeBytes = new TextEncoder().encode(type)
	const chunk = new Uint8Array(12 + data.length)
	const view = new DataView(chunk.buffer)
	view.setUint32(0, data.length)
	chunk.set(typeBytes, 4)
	chunk.set(data, 8)
	view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)))
	return chunk
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
	let value = index
	for (let bit = 0; bit < 8; bit++) {
		value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
	}
	return value >>> 0
})

/** CRC-32 (ISO 3309), the checksum of every PNG chunk over its type and data. */
export function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff
	for (const byte of bytes) {
		crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
	}
	return (crc ^ 0xffffffff) >>> 0
}
