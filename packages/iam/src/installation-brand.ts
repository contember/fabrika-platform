import { type InstallationBrand, installationBrandSchema } from '@fabrika/proxy-core/brand'
import { logWarn } from './log'
import type { InstallationBrandImages, InstallationBrandRow } from './repositories/brand'
import type { Services } from './services'

/**
 * The brand a stored row holds, checked again as every reader of a brand checks it (`@fabrika/proxy-core/brand`), or
 * null: for no row, for a cleared one, and for one the check now refuses, which then draws the fabrika mark.
 */
export function storedBrand(row: InstallationBrandRow | null): InstallationBrand | null {
	if (row === null || row.light_type === null || row.light_base64 === null) return null
	const light = { type: row.light_type, base64: row.light_base64 }
	const dark = row.dark_type === null || row.dark_base64 === null ? {} : { dark: { type: row.dark_type, base64: row.dark_base64 } }
	const parsed = installationBrandSchema.safeParse({ light, ...dark })
	if (!parsed.success) {
		console.warn('installation brand: the stored logo fails the brand check, so the pages draw the fabrika mark')
		return null
	}
	return parsed.data
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
