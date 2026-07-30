// Theme selection. The stylesheet resolves every colour through `light-dark()`, so the OS preference
// already works with no JS at all — this module exists only to let an operator PIN light or dark for
// this browser. `<html data-theme>` switches `color-scheme`; `index.html` applies the stored value
// before first paint so a pinned theme never flashes.

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'fabrika.console.theme'

function isTheme(value: string | null): value is Theme {
	return value === 'light' || value === 'dark'
}

/** The theme pinned for this browser, or null when following the OS. */
export function readPinnedTheme(): Theme | null {
	const stored = localStorage.getItem(STORAGE_KEY)
	return isTheme(stored) ? stored : null
}

/** What the OS is currently asking for. */
export function systemTheme(): Theme {
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** The theme actually in effect right now. */
export function effectiveTheme(): Theme {
	return readPinnedTheme() ?? systemTheme()
}

/** Pin a theme for this browser (or pass null to go back to following the OS). */
export function pinTheme(theme: Theme | null): void {
	if (theme === null) {
		localStorage.removeItem(STORAGE_KEY)
		document.documentElement.removeAttribute('data-theme')
		return
	}
	localStorage.setItem(STORAGE_KEY, theme)
	document.documentElement.setAttribute('data-theme', theme)
}
