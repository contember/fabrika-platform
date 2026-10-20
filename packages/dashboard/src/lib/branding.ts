import {
	type BrandImage,
	type BrandImageProblem,
	brandImageProblem,
	type BrandImageType,
	type InstallationBrand,
	isBrandImageType,
	MAX_BRAND_IMAGE_BYTES,
} from '@fabrika/proxy-core/brand'

/** What a chosen file became: an image of the brand, or why it cannot be one, in words the page shows. */
export type ChosenImage = { readonly ok: true; readonly image: BrandImage } | { readonly ok: false; readonly message: string }

const EXTENSION_TYPES: Readonly<Record<string, BrandImageType>> = { png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml' }

/**
 * A file as the brand would store it. The type the browser reports wins; without one (some systems report none for an
 * SVG) the extension names it. The bytes are then held to the same check IAM applies, so the page refuses what IAM would.
 */
export function chosenImage(bytes: Uint8Array, name: string, reportedType: string): ChosenImage {
	const type = isBrandImageType(reportedType) ? reportedType : EXTENSION_TYPES[name.split('.').pop()?.toLowerCase() ?? '']
	if (type === undefined) return { ok: false, message: problemMessage('type') }
	if (bytes.length > MAX_BRAND_IMAGE_BYTES) return { ok: false, message: problemMessage('size') }
	const image: BrandImage = { type, base64: base64Of(bytes) }
	const problem = brandImageProblem(image)
	return problem === null ? { ok: true, image } : { ok: false, message: problemMessage(problem) }
}

export function problemMessage(problem: BrandImageProblem): string {
	switch (problem) {
		case 'type':
			return 'Choose a PNG, WebP or SVG image.'
		case 'size':
			return `The image is larger than ${MAX_BRAND_IMAGE_BYTES / 1024} KB. Export it smaller, or as an SVG.`
		case 'content':
			return 'The file is not the kind of image its name says. Export it again as PNG, WebP or SVG.'
		case 'encoding':
			return 'The file could not be read. Choose it again.'
	}
}

/**
 * What the page would store: each slot is the file chosen for it, or `'stored'`, the image IAM holds. A chosen dark logo
 * alone keeps the stored light one, and a new light logo keeps the stored dark one, so neither is lost by a change of
 * the other.
 */
export interface BrandDraft {
	readonly light: BrandImage | 'stored'
	/** `null` puts the light logo on dark pages. */
	readonly dark: BrandImage | null | 'stored'
}

export const UNCHANGED_BRAND: BrandDraft = { light: 'stored', dark: 'stored' }

/** The images a draft would store over the stored logo, and whether that is a change at all. */
export function draftImages(
	stored: InstallationBrand | null,
	draft: BrandDraft,
): { readonly light: BrandImage | null; readonly dark: BrandImage | null; readonly changed: boolean } {
	return {
		light: draft.light === 'stored' ? stored?.light ?? null : draft.light,
		dark: draft.dark === 'stored' ? stored?.dark ?? null : draft.dark,
		changed: draft.light !== 'stored' || draft.dark !== 'stored',
	}
}

/** Canonical base64, in chunks small enough for `String.fromCharCode` on a large file. */
function base64Of(bytes: Uint8Array): string {
	let binary = ''
	for (let start = 0; start < bytes.length; start += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
	}
	return btoa(binary)
}
