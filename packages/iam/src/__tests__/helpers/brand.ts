// Logos the brand tests store: real images, small enough to read in a failure, which pass `brandImageProblem`.

import type { InstallationBrand } from '@fabrika/proxy-core/brand'

/** A 1x1 PNG. */
export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/** A one-rectangle SVG, for the dark page. */
export const SVG_BASE64 = btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>')

/** A brand with a light PNG and a dark SVG. */
export const TEST_BRAND: InstallationBrand = {
	light: { type: 'image/png', base64: PNG_BASE64 },
	dark: { type: 'image/svg+xml', base64: SVG_BASE64 },
}
