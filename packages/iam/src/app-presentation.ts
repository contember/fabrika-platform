import { DEFAULT_LOCALE, displayNameProblem, isLocale, type Locale } from '@fabrika/auth-core'
import type { InstallationBrand } from '@fabrika/proxy-core/brand'
import { installationBrand } from './installation-brand'
import { normalizeOrigin } from './origin'
import type { AppPresentationRow } from './repositories/app-schema'
import type { Services } from './services'

/**
 * The application a page or an e-mail is for, as IAM names it: the language, the display name, and where a completed
 * action lands. `app: null` is IAM's own page, in the installation's language.
 */
export interface AppPresentation {
	readonly app: string | null
	readonly locale: Locale
	readonly displayName: string | null
	/** The app's first registered return origin (Control registers one, its public origin), or null for none. */
	readonly landing: string | null
	/**
	 * The installation's client logo, which every page draws in place of the fabrika mark, or null for the mark. It is
	 * the installation's and not the application's; it rides here because every page already takes its presentation.
	 * An e-mail does not show it.
	 */
	readonly brand: InstallationBrand | null
}

/** The installation's words with no logo, for an e-mail. A page takes `installationPresentation`, which reads the brand. */
export const INSTALLATION_PRESENTATION: AppPresentation = { app: null, locale: DEFAULT_LOCALE, displayName: null, landing: null, brand: null }

/** The presentation of IAM's own page, in the installation's language and with its logo. */
export async function installationPresentation(services: Services): Promise<AppPresentation> {
	return { ...INSTALLATION_PRESENTATION, brand: await installationBrand(services) }
}

/** An app id is far shorter; a longer query value names no application and is not looked up. */
const MAX_APP_ID_LENGTH = 200

/**
 * The presentation of `app`, which is a hint from a query or a form, or a stored row's app. It names an application only
 * when IAM knows one by that id — a reconciled locale or display name, or a registered return origin — and is the
 * installation's otherwise. It decides words and the landing, never authority: the landing is a registered origin, so a
 * forged `app` can only pick another registered application's language and address.
 *
 * `known` is the brand a caller already holds, a request's earlier presentation's or `null` for an e-mail, which shows
 * none; given, the brand is not read again.
 */
export async function presentationFor(services: Services, app: string | null, known?: InstallationBrand | null): Promise<AppPresentation> {
	const brandOf = (): Promise<InstallationBrand | null> => known === undefined ? installationBrand(services) : Promise.resolve(known)
	if (app === null || app === '' || app.length > MAX_APP_ID_LENGTH) {
		return { ...INSTALLATION_PRESENTATION, brand: await brandOf() }
	}
	const [row, landing, brand] = await Promise.all([
		services.repositories.appSchema.getPresentation(app),
		registeredLanding(services, app),
		brandOf(),
	])
	if (row === null && landing === null) {
		return { ...INSTALLATION_PRESENTATION, brand }
	}
	const declared = parsePresentation(row)
	return { app, locale: declared.locale ?? DEFAULT_LOCALE, displayName: declared.displayName, landing, brand }
}

/** The app's first registered return origin that the origin rule still admits, or null. */
async function registeredLanding(services: Services, app: string): Promise<string | null> {
	const origins = await services.repositories.handoff.listReturnOrigins(app)
	// A stored origin is written into a CSP directive and a `Location`; one the rule no longer admits is no landing.
	return origins.find((origin) => normalizeOrigin(origin) === origin) ?? null
}

/** A stored row read back: a locale IAM no longer speaks, or a name the rule refuses, counts as not declared. */
export function parsePresentation(row: AppPresentationRow | null): { locale: Locale | null; displayName: string | null } {
	const locale = row?.locale ?? null
	const displayName = row?.display_name ?? null
	return {
		locale: isLocale(locale) ? locale : null,
		displayName: displayName !== null && displayNameProblem(displayName) === null ? displayName : null,
	}
}

/** The URL a completed action sends the browser to inside the app, or null when the app has no registered origin. */
export function landingUrl(presentation: AppPresentation): string | null {
	return presentation.landing === null ? null : `${presentation.landing}/`
}

/** The installation's console: the registered origin of the first admin audience that has one, or null for none. */
export async function installationConsole(services: Services): Promise<string | null> {
	for (const app of services.config.adminAudiences) {
		if (app === '' || app.length > MAX_APP_ID_LENGTH) continue
		const landing = await registeredLanding(services, app)
		if (landing !== null) return landing
	}
	return null
}

/**
 * Where a browser lands when nothing names its destination — a sign-in, a sign-out or a completed action of no
 * application: the installation's console, whose proxy then signs the browser in through the normal handoff. IAM's
 * own origin serves no page at `/`, and on Zerops the proxy answers it with 403. Without a registered console it is
 * IAM's sign-in page.
 */
export async function installationLanding(services: Services): Promise<string> {
	const console = await installationConsole(services)
	return console === null ? new URL('/auth/login', services.config.issuer).toString() : `${console}/`
}

/**
 * The origin off IAM where a completed action of `presentation` lands, which its page's `form-action` must admit:
 * the application's own, else the console. Null when it lands on IAM's own sign-in page.
 */
export async function actionLandingOrigin(services: Services, presentation: AppPresentation): Promise<string | null> {
	return presentation.landing ?? await installationConsole(services)
}

/** The `?app=` query a link or a form carries so the next page speaks for the same application; empty for none. */
export function appQuery(presentation: AppPresentation): string {
	return presentation.app === null ? '' : `?app=${encodeURIComponent(presentation.app)}`
}
