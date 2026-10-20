/**
 * The client's brand on fabrika's own pages (ADR-0065). An installation serves one client, so its logo is one setting
 * of the installation: IAM keeps it, the console's Settings writes it, and the proxy manifest carries it to the pages the
 * proxy answers with on every application host. A page shows it where it would otherwise draw the fabrika mark.
 *
 * A logo is an image a page embeds as a `data:` URI in an `<img>`, never markup: an SVG in an image runs no script, and
 * a page that carries it loads nothing. Every consumer checks it here, the IAM write, the manifest parser and the
 * console's own pre-check, so a logo that one of them admits passes the others. This module imports zod and nothing
 * else, so the browser can use it.
 */

import { z } from 'zod'

export type BrandImageType = 'image/png' | 'image/webp' | 'image/svg+xml'

export const BRAND_IMAGE_TYPES: readonly BrandImageType[] = ['image/png', 'image/webp', 'image/svg+xml']

/** The most one image may weigh, decoded. A page carries it in every copy Caddy serves, so it stays a logo's size. */
export const MAX_BRAND_IMAGE_BYTES = 32 * 1024

/** One image of the brand: its type and its bytes as canonical base64. */
export interface BrandImage {
	readonly type: BrandImageType
	readonly base64: string
}

/** The logo for a light page, and the one for a dark page when the light one would not read there. */
export interface InstallationBrand {
	readonly light: BrandImage
	readonly dark?: BrandImage
}

export type BrandImageProblem = 'type' | 'encoding' | 'size' | 'content'

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const MAX_BASE64_LENGTH = Math.ceil(MAX_BRAND_IMAGE_BYTES / 3) * 4

/** Why an image cannot be the brand, or null. The type must be one of three and must be what the bytes are. */
export function brandImageProblem(image: { readonly type: string; readonly base64: string }): BrandImageProblem | null {
	if (!isBrandImageType(image.type)) return 'type'
	if (image.base64.length === 0 || !BASE64.test(image.base64)) return 'encoding'
	if (image.base64.length > MAX_BASE64_LENGTH) return 'size'
	const bytes = decode(image.base64)
	// Base64 with stray bits in its last character decodes to the same bytes; only the canonical spelling is one image.
	if (bytes === null || encode(bytes) !== image.base64) return 'encoding'
	if (bytes.length > MAX_BRAND_IMAGE_BYTES) return 'size'
	return sniff(bytes) === image.type ? null : 'content'
}

export function isBrandImageType(value: string): value is BrandImageType {
	return BRAND_IMAGE_TYPES.some((type) => type === value)
}

export const brandImageSchema = z.object({
	type: z.enum(['image/png', 'image/webp', 'image/svg+xml']),
	base64: z.string(),
}).strict().superRefine((image, ctx) => {
	const problem = brandImageProblem(image)
	if (problem !== null) ctx.addIssue({ code: 'custom', message: `not a brand image: ${problem}` })
}) satisfies z.ZodType<BrandImage, z.ZodTypeDef, unknown>

export const installationBrandSchema = z.object({
	light: brandImageSchema,
	dark: brandImageSchema.optional(),
}).strict() satisfies z.ZodType<InstallationBrand, z.ZodTypeDef, unknown>

/** The image as the `src` of an `<img>`. Base64 holds no `{`, so a Caddy `static_response` body keeps it as it is. */
export function brandImageDataUri(image: BrandImage): string {
	return `data:${image.type};base64,${image.base64}`
}

/** What the bytes are, read from their start, never from what the uploader called them. */
function sniff(bytes: Uint8Array): BrandImageType | null {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
	if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) return 'image/webp'
	return isSvg(bytes) ? 'image/svg+xml' : null
}

/**
 * UTF-8 text whose first element is `<svg`, after an optional byte order mark, an XML declaration, comments and a
 * doctype. An image of type SVG renders inert in an `<img>`, so this only has to stop another kind of file posing as one.
 */
function isSvg(bytes: Uint8Array): boolean {
	let text: string
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		return false
	}
	let rest = text.replace(/^﻿/, '')
	for (;;) {
		const trimmed = rest.replace(/^\s+/, '')
		const prologue = /^(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE\s+svg[^>]*>)/i.exec(trimmed)
		if (prologue === null) return /^<svg[\s>]/.test(trimmed)
		rest = trimmed.slice(prologue[0].length)
	}
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
	return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte)
}

function decode(base64: string): Uint8Array | null {
	try {
		const binary = atob(base64)
		const bytes = new Uint8Array(binary.length)
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
		return bytes
	} catch {
		return null
	}
}

function encode(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
}
