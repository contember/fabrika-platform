import type { ReviewAnchor } from '../src/review/model'

type ReviewBrowser = NonNullable<ReviewAnchor['browser']>

const MAX_UNKNOWN = 100

/** Most specific first: Edge and Opera also name Chrome, and Chrome also names Safari. */
const BROWSERS: ReadonlyArray<readonly [string, RegExp]> = [
	['Edge', /\bEdg(?:e|A|iOS)?\/(\d+)/],
	['Opera', /\bOPR\/(\d+)/],
	['Firefox', /\b(?:Firefox|FxiOS)\/(\d+)/],
	['Chrome', /\b(?:Chrome|CriOS)\/(\d+)/],
	['Safari', /\bVersion\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//],
]

/** Most specific first: Android also names Linux, and iOS names Mac OS X. */
const SYSTEMS: ReadonlyArray<readonly [string, RegExp]> = [
	['Android', /\bAndroid\b/],
	['iOS', /\b(?:iPhone|iPad|iPod)\b/],
	['Windows', /\bWindows\b/],
	['macOS', /\bMac OS X\b/],
	['Linux', /\bLinux\b/],
]

/** Browser, major version and operating system, e.g. `Chrome 141 · Linux`; the rest of a user agent is noise. */
export function browserName(userAgent: string): string {
	let browser: string | undefined
	for (const [name, pattern] of BROWSERS) {
		const version = pattern.exec(userAgent)?.[1]
		if (version !== undefined) {
			browser = `${name} ${version}`
			break
		}
	}
	const system = SYSTEMS.find(([, pattern]) => pattern.test(userAgent))?.[0]
	const parts = [browser, system].filter((part) => part !== undefined)
	return parts.length === 0 ? userAgent.slice(0, MAX_UNKNOWN) : parts.join(' · ')
}

export function browserOf(view: Window): ReviewBrowser {
	return {
		name: browserName(view.navigator.userAgent),
		viewport: { width: view.innerWidth, height: view.innerHeight, scale: view.devicePixelRatio },
		colorScheme: view.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
	}
}
