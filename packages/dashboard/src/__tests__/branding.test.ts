import type { InstallationBrandDto } from '@fabrika/iam-contract'
import { type BrandImage, brandImageDataUri, type InstallationBrand } from '@fabrika/proxy-core/brand'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chosenImage, draftImages, UNCHANGED_BRAND } from '../lib/branding'
import { type ConsoleCaller, mayOpen } from '../lib/console-access'
import { visibleNav } from '../routes/_layout'
import { BrandingEditor } from '../routes/settings/branding'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function bytesOf(base64: string): Uint8Array {
	return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
}

describe('a chosen logo file', () => {
	test('becomes the image IAM stores, typed by the browser or else by its extension', () => {
		expect(chosenImage(bytesOf(PNG), 'logo.png', 'image/png')).toEqual({ ok: true, image: { type: 'image/png', base64: PNG } })
		const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
		expect(chosenImage(svg, 'Logo.SVG', '')).toEqual({
			ok: true,
			image: { type: 'image/svg+xml', base64: btoa('<svg xmlns="http://www.w3.org/2000/svg"/>') },
		})
	})

	test('is refused, in words, when IAM would refuse it', () => {
		expect(chosenImage(bytesOf(PNG), 'logo.gif', 'image/gif')).toEqual({ ok: false, message: 'Choose a PNG, WebP or SVG image.' })
		expect(chosenImage(bytesOf(PNG), 'logo.webp', 'image/webp').ok).toBe(false)
		expect(chosenImage(new Uint8Array(32 * 1024 + 1), 'logo.png', 'image/png')).toEqual({
			ok: false,
			message: 'The image is larger than 32 KB. Export it smaller, or as an SVG.',
		})
	})
})

describe('a change of the logo', () => {
	const png: BrandImage = { type: 'image/png', base64: PNG }
	const svg: BrandImage = { type: 'image/svg+xml', base64: btoa('<svg xmlns="http://www.w3.org/2000/svg"/>') }
	const stored: InstallationBrand = { light: png, dark: svg }

	test('keeps the stored image of the slot it does not touch', () => {
		expect(draftImages(stored, { light: svg, dark: 'stored' })).toEqual({ light: svg, dark: svg, changed: true })
		expect(draftImages(stored, { light: 'stored', dark: png })).toEqual({ light: png, dark: png, changed: true })
		expect(draftImages(stored, { light: 'stored', dark: null })).toEqual({ light: png, dark: null, changed: true })
	})

	test('is no change until a slot is chosen, and has no light logo to store without one', () => {
		expect(draftImages(stored, UNCHANGED_BRAND)).toEqual({ light: png, dark: svg, changed: false })
		expect(draftImages(null, { light: 'stored', dark: svg })).toEqual({ light: null, dark: svg, changed: true })
	})
})

describe('the Branding page', () => {
	const none: InstallationBrandDto = { brand: null, updatedAt: null }
	const set: InstallationBrandDto = { brand: { light: { type: 'image/png', base64: PNG } }, updatedAt: 1_800_000_000 }

	test('shows the fabrika mark until a logo is set, and the logo on both grounds once it is', () => {
		const empty = renderToStaticMarkup(createElement(BrandingEditor, { current: none, republishes: true, onSaved: () => {} }))
		expect(empty).toContain('class="brand-glyph"')
		expect(empty).not.toContain('Remove logo')
		const branded = renderToStaticMarkup(createElement(BrandingEditor, { current: set, republishes: true, onSaved: () => {} }))
		expect(branded.split(`src="${brandImageDataUri({ type: 'image/png', base64: PNG })}"`).length - 1).toBe(2)
		expect(branded).toContain('Remove logo')
	})

	test("is an installation administrator's, beside Source connection in the rail", () => {
		const admin: ConsoleCaller = { access: null, iam: { kind: 'installation' }, administersPeople: false }
		const userAdmin: ConsoleCaller = { access: null, iam: { kind: 'users', apps: null }, administersPeople: false }
		expect(mayOpen(admin, 'settings/branding')).toBe(true)
		expect(mayOpen(userAdmin, 'settings/branding')).toBe(false)
		expect(mayOpen({ ...admin, iam: false }, 'settings/branding')).toBe(false)
		const delivery = visibleNav(admin).sections.find((section) => section.label === 'Delivery')?.items.map((item) => item.label) ?? []
		expect(delivery.slice(delivery.indexOf('Source connection'), delivery.indexOf('Source connection') + 2)).toEqual(['Source connection', 'Branding'])
	})
})
