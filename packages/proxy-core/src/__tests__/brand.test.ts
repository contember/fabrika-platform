/**
 * The client's logo is an image of three kinds, at most 32 KB, in canonical base64, whose bytes are what its type says.
 * The IAM write, the manifest parser and the console run this one check, so a logo one of them admits passes the others.
 */

import { describe, expect, test } from 'bun:test'
import { type BrandImage, brandImageDataUri, brandImageProblem, type BrandImageType, installationBrandSchema, MAX_BRAND_IMAGE_BYTES } from '../brand'
import { parseProxyManifest } from '../manifest'
import { pageArt } from '../page-style'
import { errorPage } from '../pages'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function bytesOf(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

function base64Of(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
}

function svg(text: string): { type: BrandImageType; base64: string } {
	return { type: 'image/svg+xml', base64: base64Of(bytesOf(text)) }
}

function webp(): { type: BrandImageType; base64: string } {
	const bytes = new Uint8Array(16)
	bytes.set(bytesOf('RIFF'), 0)
	bytes.set(bytesOf('WEBP'), 8)
	return { type: 'image/webp', base64: base64Of(bytes) }
}

describe('a brand image', () => {
	test('a PNG, a WebP and an SVG are admitted, the SVG after a declaration, comments and a doctype', () => {
		expect(brandImageProblem({ type: 'image/png', base64: PNG })).toBeNull()
		expect(brandImageProblem(webp())).toBeNull()
		expect(brandImageProblem(svg('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
		expect(
			brandImageProblem(svg('﻿<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg viewBox="0 0 1 1"></svg>')),
		).toBeNull()
	})

	test('another type, or bytes that are not what the type says, are refused', () => {
		expect(brandImageProblem({ type: 'image/gif', base64: PNG })).toBe('type')
		expect(brandImageProblem({ type: 'image/webp', base64: PNG })).toBe('content')
		expect(brandImageProblem(svg('<html><body><svg></svg></body></html>'))).toBe('content')
		expect(brandImageProblem({ type: 'image/svg+xml', base64: PNG })).toBe('content')
		expect(brandImageProblem({ type: 'image/svg+xml', base64: base64Of(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x20, 0xff])) })).toBe('content')
	})

	test('only canonical base64 is one image', () => {
		expect(brandImageProblem({ type: 'image/png', base64: '' })).toBe('encoding')
		expect(brandImageProblem({ type: 'image/png', base64: `${PNG.slice(0, -2)}` })).toBe('encoding')
		expect(brandImageProblem({ type: 'image/png', base64: PNG.replace(/=+$/, '') })).toBe('encoding')
		expect(brandImageProblem({ type: 'image/png', base64: ` ${PNG}` })).toBe('encoding')
		// The last character carries bits the decoder drops: `Q==` and `R==` decode to the same byte.
		expect(brandImageProblem(svg('<svg/>A'))).toBe('content')
		const stray = base64Of(bytesOf('<svg/>A')).replace(/Q==$/, 'R==')
		expect(brandImageProblem({ type: 'image/svg+xml', base64: stray })).toBe('encoding')
	})

	test('at most 32 KB decoded', () => {
		const head = '<svg xmlns="http://www.w3.org/2000/svg">'
		const fits = `${head}${' '.repeat(MAX_BRAND_IMAGE_BYTES - head.length - 6)}</svg>`
		expect(bytesOf(fits).length).toBe(MAX_BRAND_IMAGE_BYTES)
		expect(brandImageProblem(svg(fits))).toBeNull()
		expect(brandImageProblem(svg(`${fits} `))).toBe('size')
	})

	test('a light logo and an optional dark one, nothing else', () => {
		expect(installationBrandSchema.safeParse({ light: { type: 'image/png', base64: PNG } }).success).toBe(true)
		expect(installationBrandSchema.safeParse({ light: { type: 'image/png', base64: PNG }, dark: webp() }).success).toBe(true)
		expect(installationBrandSchema.safeParse({ dark: webp() }).success).toBe(false)
		expect(installationBrandSchema.safeParse({ light: { type: 'image/png', base64: PNG }, href: 'https://example.com' }).success).toBe(false)
	})
})

describe('the brand in the manifest and on the pages', () => {
	const light: BrandImage = { type: 'image/png', base64: PNG }

	test('the manifest carries an admitted brand, and refuses the whole manifest for one it would not admit', () => {
		expect(parseProxyManifest({ apps: [], brand: { light } })).toEqual({ apps: [], brand: { light } })
		expect(parseProxyManifest({ apps: [] })).toEqual({ apps: [] })
		expect(parseProxyManifest({ apps: [], brand: { light: { type: 'image/webp', base64: PNG } } })).toBeNull()
	})

	test('a page shows the logo where it would draw the mark, as an image, with the dark variant for a dark page', () => {
		expect(pageArt(null)).toStartWith('<svg ')
		expect(pageArt({ light })).toBe(`<picture><img src="${brandImageDataUri(light)}" alt=""></picture>`)
		const dark = webp()
		expect(pageArt({ light, dark })).toBe(
			`<picture><source media="(prefers-color-scheme: dark)" srcset="${brandImageDataUri(dark)}"><img src="${
				brandImageDataUri(light)
			}" alt=""></picture>`,
		)
		const page = errorPage(403, { brand: { light } })
		expect(page).toContain(`<div class="art" aria-hidden="true"><picture><img src="${brandImageDataUri(light)}" alt=""></picture></div>`)
		// The footer names fabrika whatever the art shows.
		expect(page).toMatch(/<span class="runs-on">Runs on <svg[^>]*>.*?<\/svg> fabrika<\/span>/)
	})
})
