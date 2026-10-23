import { type InstallationBrand, installationBrandSchema } from '@fabrika/proxy-core/brand'
import { logWarn } from './log'
import type { InstallationBrandImages, InstallationBrandRow } from './repositories/brand'
import type { Services } from './services'

type StoredImages = Pick<InstallationBrandRow, 'light_type' | 'light_base64' | 'dark_type' | 'dark_base64'>

/** The images last checked, what the check made of them, and when a refusal of them was last logged (`storedBrand`). */
let lastChecked: { readonly row: StoredImages; readonly brand: InstallationBrand | null; warnedAt: number } | null = null

/** How often a stored logo the check refuses is logged again, so the reason the pages lost it stays in the logs. */
export const REFUSED_BRAND_WARN_INTERVAL_MS = 60 * 60 * 1000

/**
 * The brand a stored row holds, checked again as every reader of a brand checks it (`@fabrika/proxy-core/brand`), or
 * null: for no row, for a cleared one, and for one the check now refuses, which then draws the fabrika mark.
 *
 * Every page reads the row, and it changes only with `brand.set` and `brand.clear`, so the check of the images last
 * read is kept and a row with the same images takes its answer: comparing the stored strings is far cheaper than
 * decoding them again. The key is the images themselves, never a time, so a change is checked whichever instance made it.
 * A refused logo is logged when it is checked and again every `REFUSED_BRAND_WARN_INTERVAL_MS` while pages read it.
 */
export function storedBrand(row: InstallationBrandRow | null, now: number = Date.now()): InstallationBrand | null {
	if (row === null || row.light_type === null || row.light_base64 === null) {
		lastChecked = null
		return null
	}
	if (lastChecked !== null && sameImages(lastChecked.row, row)) {
		if (lastChecked.brand === null && now - lastChecked.warnedAt >= REFUSED_BRAND_WARN_INTERVAL_MS) {
			warnRefused()
			lastChecked.warnedAt = now
		}
		return lastChecked.brand
	}
	const light = { type: row.light_type, base64: row.light_base64 }
	const dark = row.dark_type === null || row.dark_base64 === null ? {} : { dark: { type: row.dark_type, base64: row.dark_base64 } }
	const parsed = installationBrandSchema.safeParse({ light, ...dark })
	if (!parsed.success) warnRefused()
	const brand = parsed.success ? parsed.data : null
	lastChecked = { row, brand, warnedAt: now }
	return brand
}

function warnRefused(): void {
	console.warn('installation brand: the stored logo fails the brand check, so the pages draw the fabrika mark')
}

function sameImages(a: StoredImages, b: StoredImages): boolean {
	return a.light_type === b.light_type && a.light_base64 === b.light_base64 && a.dark_type === b.dark_type && a.dark_base64 === b.dark_base64
}

/** The images of `brand` as the repository stores them. */
export function brandImages(brand: InstallationBrand): InstallationBrandImages {
	return { light: brand.light, dark: brand.dark ?? null }
}

/**
 * The brand every IAM page draws, read once per render. A logo is decoration: a read that fails draws the fabrika mark
 * and logs the failure's message, never the row, so a page that would otherwise render never fails for its logo.
 */
export async function installationBrand(services: Services): Promise<InstallationBrand | null> {
	try {
		return storedBrand(await services.repositories.brand.get())
	} catch (err) {
		logWarn('installation brand could not be read, the page draws the fabrika mark', err)
		return null
	}
}
