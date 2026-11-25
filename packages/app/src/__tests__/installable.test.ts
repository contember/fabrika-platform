// An SPA mount as an installable application (ADR-0087): its manifest and icons are served under the mount's own
// access, behind the production proxy decision, and its pages link them with the session.

import { compileContract, ContractError, defineContract } from '@fabrika/app/contract'
import { testKit } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'
import { inflateSync } from 'node:zlib'
import { headInsertionPoint } from '../implement/html'
import { implement } from '../implement/implement'
import { appManifest, colourKey, crc32, drawIcon, iconColour, initialOf, installLinks } from '../implement/installable'

const vocabulary = {
	app: 'intake',
	dimensions: { workspace: {} },
	actions: { 'intake.read': 'Read submissions' },
	roles: { reviewer: { grants: ['intake.read'], member: { scope: 'workspace', assignableBy: ['reviewer'] } } },
} as const

const contract = defineContract(vocabulary, (c) => ({
	web: c.spa('/', { dir: 'dist/web', access: { member: true } }),
	admin: c.spa('/admin', { dir: 'dist/admin', access: { member: true } }),
	site: c.spa('/site', { dir: 'dist/site', access: { public: true } }),
	health: c.health('/healthz'),
}))

const app = implement(contract, { database: null, deps: () => ({}), handlers: () => ({}) })

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/main.js"></script></head><body></body></html>'

interface Served {
	readonly dir: string
	readonly path: string
}

/** A kit whose asset server answers every path with the page, and every other file with its path, and records each. */
function kitWithAssets(): { readonly kit: ReturnType<typeof testKit>; readonly served: Served[] } {
	const served: Served[] = []
	const kit = testKit(app, {
		assets: {
			serve: (mount, request) => {
				const path = new URL(request.url).pathname
				served.push({ dir: mount.dir, path })
				return Promise.resolve(
					path.endsWith('.js')
						? new Response('void 0', { headers: { 'Content-Type': 'text/javascript' } })
						: new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
				)
			},
		},
	})
	return { kit, served }
}

describe('the manifest', () => {
	test('is derived from the contract: its id, the mount as scope and start URL, standalone, the icons', () => {
		const colour = iconColour('intake')
		const hex = '#' + colour.map((channel) => channel.toString(16).padStart(2, '0')).join('')
		expect(appManifest({ app: 'intake', displayName: undefined, mount: 'web', prefix: '/' })).toEqual({
			id: '/',
			name: 'intake',
			short_name: 'intake',
			start_url: '/',
			scope: '/',
			display: 'standalone',
			theme_color: hex,
			background_color: hex,
			icons: [
				{ src: '/__fabrika-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
				{ src: '/__fabrika-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
				{ src: '/__fabrika-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
			],
		})
	})

	test("names the contract's display name, and a mount below the root by its own name too", () => {
		const admin = appManifest({ app: 'intake', displayName: 'Příjem zakázek', mount: 'admin', prefix: '/admin' })
		expect([admin.name, admin.short_name, admin.scope, admin.start_url, admin.id]).toEqual([
			'Příjem zakázek · admin',
			'Příjem admin',
			'/admin/',
			'/admin/',
			'/admin/',
		])
		expect(admin.icons.map((icon) => icon.src)).toEqual([
			'/admin/__fabrika-icon-192.png',
			'/admin/__fabrika-icon-512.png',
			'/admin/__fabrika-icon-512.png',
		])
		expect(appManifest({ app: 'intake', displayName: 'Longwordwithoutspaces', mount: 'web', prefix: '/' }).short_name).toBe('Longwordwith')
	})

	test('two mounts of one application never install as the same entry: the short name keeps the mount, the colour differs', () => {
		const orders = { app: 'orders', displayName: 'Orders' }
		const root = appManifest({ ...orders, mount: 'web', prefix: '/' })
		const admin = appManifest({ ...orders, mount: 'admin', prefix: '/admin' })
		const portal = appManifest({ ...orders, mount: 'portal', prefix: '/portal' })
		expect([root.short_name, admin.short_name, portal.short_name]).toEqual(['Orders', 'Orders admin', 'portal'])
		expect(new Set([root.theme_color, admin.theme_color, portal.theme_color]).size).toBe(3)
		// The root mount keeps the colour of the application id alone.
		expect(iconColour(colourKey({ ...orders, mount: 'web', prefix: '/' }))).toEqual(iconColour('orders'))
	})

	test('the page links it with the session and names the touch icon', () => {
		expect(installLinks('/admin')).toBe(
			'<link rel="manifest" href="/admin/__fabrika-app.webmanifest" crossorigin="use-credentials">'
				+ '<link rel="apple-touch-icon" href="/admin/__fabrika-icon-180.png">',
		)
	})
})

describe('the icon', () => {
	test('is a valid truecolour PNG of its size, every chunk checksummed', async () => {
		const png = await drawIcon(192, 'Intake', iconColour('intake'))
		expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
		const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
		const chunks: { type: string; data: Uint8Array }[] = []
		for (let at = 8; at < png.length;) {
			const length = view.getUint32(at)
			const type = new TextDecoder().decode(png.subarray(at + 4, at + 8))
			const data = png.subarray(at + 8, at + 8 + length)
			expect(view.getUint32(at + 8 + length)).toBe(Bun.hash.crc32(png.subarray(at + 4, at + 8 + length)))
			chunks.push({ type, data })
			at += 12 + length
		}
		expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
		const header = chunks[0]?.data ?? new Uint8Array()
		expect([...header]).toEqual([0, 0, 0, 192, 0, 0, 0, 192, 8, 2, 0, 0, 0])
		const scanlines = inflateSync(chunks[1]?.data ?? new Uint8Array())
		expect(scanlines.length).toBe(192 * (1 + 192 * 3))
	})

	test("is the application's colour with its initial in white inside the maskable safe zone", async () => {
		const size = 512
		const colour = iconColour('intake')
		const png = await drawIcon(size, 'Intake', colour)
		const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
		const idatLength = view.getUint32(33)
		const scanlines = inflateSync(png.subarray(41, 41 + idatLength))
		const pixel = (x: number, y: number): number[] => [...scanlines.subarray(y * (1 + size * 3) + 1 + x * 3, y * (1 + size * 3) + 4 + x * 3)]
		expect(pixel(0, 0)).toEqual([...colour])
		expect(pixel(size - 1, size - 1)).toEqual([...colour])
		// The I's stem is the glyph's middle column: white at the centre of the icon.
		expect(pixel(size / 2, size / 2)).toEqual([255, 255, 255])
		const white: [number, number][] = []
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				if (pixel(x, y)[0] === 255 && pixel(x, y)[1] === 255) white.push([x, y])
			}
		}
		expect(white.length).toBeGreaterThan(0)
		const centre = size / 2
		expect(white.every(([x, y]) => Math.hypot(x - centre, y - centre) <= size * 0.4)).toBe(true)
	})

	test('takes the first letter or digit, without its diacritics, and draws none for a name without one', async () => {
		expect([initialOf('Účetnictví'), initialOf('  42 sklad'), initialOf('★'), initialOf('žádosti')]).toEqual(['U', '4', null, 'Z'])
		const colour = iconColour('intake')
		const plain = await drawIcon(180, '…', colour)
		const scanlines = inflateSync(plain.subarray(41, 41 + new DataView(plain.buffer, plain.byteOffset).getUint32(33)))
		const expected = new Uint8Array(180 * 541)
		for (let y = 0; y < 180; y++) {
			for (let x = 0; x < 180; x++) expected.set(colour, y * 541 + 1 + x * 3)
		}
		expect(new Uint8Array(scanlines)).toEqual(expected)
	})

	test('the colour is stable per application and differs between applications', () => {
		expect(iconColour('intake')).toEqual(iconColour('intake'))
		expect(iconColour('intake')).not.toEqual(iconColour('crm'))
	})

	test('crc32 is ISO 3309', () => {
		const bytes = new TextEncoder().encode('123456789')
		expect(crc32(bytes)).toBe(0xcbf43926)
		expect(crc32(bytes)).toBe(Bun.hash.crc32(bytes))
	})
})

describe('the production proxy and the dispatcher serve them under the mount', () => {
	test('a member gets the manifest, the icons and a page that links them; the asset server sees none of the files', async () => {
		const { kit, served } = kitWithAssets()
		const browser = kit.browser(kit.testCaller([{ role: 'reviewer', scope: { type: 'workspace', value: 'w1' } }]))

		const manifest = await browser('/__fabrika-app.webmanifest')
		expect(manifest.status).toBe(200)
		expect(manifest.headers.get('Content-Type')).toBe('application/manifest+json')
		expect(manifest.headers.get('Cache-Control')).toBe('no-store')
		expect(await manifest.json()).toEqual(JSON.parse(JSON.stringify(appManifest({ app: 'intake', displayName: undefined, mount: 'web', prefix: '/' }))))

		for (const size of [180, 192, 512]) {
			const icon = await browser('/__fabrika-icon-' + String(size) + '.png')
			expect(icon.status).toBe(200)
			expect(icon.headers.get('Content-Type')).toBe('image/png')
			const bytes = new Uint8Array(await icon.arrayBuffer())
			expect(new DataView(bytes.buffer).getUint32(16)).toBe(size)
		}
		expect(served).toEqual([])

		const page = await browser('/notes/7')
		expect(page.headers.get('Content-Type')).toContain('text/html')
		expect(await page.text()).toBe(PAGE.replace('<head>', '<head>' + installLinks('/')))
		const script = await browser('/main.js')
		expect(await script.text()).toBe('void 0')

		const admin = await browser('/admin/__fabrika-app.webmanifest')
		expect(((await admin.json()) as { scope: string }).scope).toBe('/admin/')
		expect(await (await browser('/admin/')).text()).toContain(installLinks('/admin'))
	})

	test('without a session the manifest and the icons are refused like any page of the mount: a bounce, or a 401', async () => {
		const { kit, served } = kitWithAssets()
		const navigation = await kit.fetch('/__fabrika-app.webmanifest')
		expect(navigation.status).toBe(302)
		expect(navigation.headers.get('Location')).toStartWith('https://iam.test/auth/login?')
		// What a browser's own manifest and icon fetches send: no navigation, so the proxy answers the login URL as data.
		const manifest = await kit.fetch('/__fabrika-app.webmanifest', { headers: { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'manifest' } })
		expect(manifest.status).toBe(401)
		const icon = await kit.fetch('/admin/__fabrika-icon-512.png', { headers: { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' } })
		expect(icon.status).toBe(401)
		expect(served).toEqual([])
	})

	test('a public mount is no application to install: no manifest of its own, no links in its pages', async () => {
		const { kit, served } = kitWithAssets()
		const manifest = await kit.fetch('/site/__fabrika-app.webmanifest')
		expect(manifest.headers.get('Content-Type')).toContain('text/html')
		expect(await (await kit.fetch('/site/')).text()).toBe(PAGE)
		expect(served).toEqual([{ dir: 'dist/site', path: '/site/__fabrika-app.webmanifest' }, { dir: 'dist/site', path: '/site/' }])
	})

	test('the proxy table is the one the contract compiles to: no row of its own, nothing public', () => {
		const artifact = compileContract(contract, {})
		const kinds = Object.fromEntries(artifact.endpoints.map((row) => [row.id, row.kind]))
		expect(kinds).toEqual({ web: 'spa', admin: 'spa', 'admin.prefix': 'spa', site: 'public-spa', 'site.prefix': 'public-spa', health: 'health' })
		expect(artifact.endpoints.filter((row) => row.path.includes('__fabrika'))).toEqual([])
	})
})

describe('the links go to the start of the head, never before the DOCTYPE', () => {
	test.each<[string, string, string]>([
		['after the head start tag', '<!doctype html><html lang="cs"><head><meta charset="utf-8">', '<!doctype html><html lang="cs"><head>'],
		['after whitespace and line breaks of the prologue', '<!DOCTYPE html>\n<html>\n  <head>\n<title>', '<!DOCTYPE html>\n<html>\n  <head>'],
		['after the DOCTYPE, where the head and html tags are omitted', '<!doctype html><title>Notes</title>', '<!doctype html>'],
		['after the html start tag, where the head tag is omitted', '<!doctype html><html><title>Notes</title>', '<!doctype html><html>'],
		['after comments before the DOCTYPE', '<!-- built --><!doctype html><head>', '<!-- built --><!doctype html><head>'],
		['not into a header element', '<!doctype html><header>', '<!doctype html>'],
		['at the very start of a fragment, never at a head written later in it', '<p>a <head> in the text</p>', ''],
	])('%s', (_name, html, prologue) => {
		expect(headInsertionPoint(html)).toBe(prologue.length)
	})

	test('after a byte order mark, then the prologue', () => {
		const mark = String.fromCharCode(0xfeff)
		expect(headInsertionPoint(mark + '<!doctype html><title>x</title>')).toBe(1 + '<!doctype html>'.length)
		expect(headInsertionPoint(mark + '<p>text</p>')).toBe(1)
	})
})

function problemsOf(compile: () => unknown): readonly string[] {
	try {
		compile()
	} catch (error) {
		if (error instanceof ContractError) {
			return error.problems
		}
		throw error
	}
	throw new Error('the contract compiled')
}

describe('no other endpoint may take a file an SPA mount serves', () => {
	test('a health endpoint at the manifest path of a credentialed mount is refused, naming both', () => {
		const claimed = defineContract(vocabulary, (c) => ({
			admin: c.spa('/admin', { dir: 'dist/admin', access: { member: true } }),
			probe: c.health('/admin/__fabrika-app.webmanifest'),
		}))
		expect(problemsOf(() => compileContract(claimed, {}))).toEqual([
			"mount 'admin': '/admin/__fabrika-app.webmanifest' is served by 'probe' (health); the framework serves the mount's __fabrika-app.webmanifest there, so no other endpoint may take it",
		])
	})

	test("an icon path, and the browser config of any mount, are refused the same way; a public mount's manifest path is free", () => {
		const claimed = defineContract(vocabulary, (c) => ({
			web: c.spa('/', { dir: 'dist/web', access: { member: true } }),
			site: c.spa('/site', { dir: 'dist/site', access: { public: true } }),
			icon: c.health('/__fabrika-icon-512.png'),
			config: c.health('/site/__fabrika-config.json'),
			free: c.health('/site/__fabrika-app.webmanifest'),
		}))
		const problems = problemsOf(() => compileContract(claimed, {}))
		expect(problems).toHaveLength(2)
		expect(problems.some((problem) => problem.startsWith("mount 'web': '/__fabrika-icon-512.png' is served by 'icon' (health)"))).toBe(true)
		expect(problems.some((problem) => problem.startsWith("mount 'site': '/site/__fabrika-config.json' is served by 'config' (health)"))).toBe(true)
	})
})
