import { DEFAULT_LOCALE, displayNameProblem, isLocale, type Locale } from '@fabrika/auth-core'
import type { InstallationBrand } from '@fabrika/proxy-core/brand'
import { installationBrand } from './installation-brand'
import { normalizeOrigin } from './origin'
import { chooseLocale, LOCALE_PARAM, parseLocale, requestLocales } from './person-locale'
import type { AppPresentationRow } from './repositories/app-schema'
import type { Services } from './services'

/**
 * The application a page or an e-mail is for, as IAM names it: the language, the display name, and where a completed
 * action lands. `app: null` is IAM's own page, in the reader's language else the installation's.
 */
export interface AppPresentation {
	readonly app: string | null
	/** The language of the page or the mail (`chooseLocale`). */
	readonly locale: Locale
	/**
	 * The reader's own language when this page or mail knows one: stored for the flow, or named by its link. The links
	 * and forms it builds carry it (`appQuery`), so the next page keeps it; null when the words follow the application.
	 */
	readonly personLocale: Locale | null
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
export const INSTALLATION_PRESENTATION: AppPresentation = {
	app: null,
	locale: DEFAULT_LOCALE,
	personLocale: null,
	displayName: null,
	landing: null,
	brand: null,
}

/**
 * Who reads a page or a mail, beside the application it is for. `request` is the page's own: its `?locale=`, the
 * remembered language and its `Accept-Language` pick words; a mail has none. `locale` is the person's own language as
 * IAM stored it for this flow (an invitation's, a password action's, a principal's), which beats every other source.
 */
export interface Reader {
	readonly request?: Request | null
	readonly locale?: string | null
	/**
	 * The brand a caller already holds, a request's earlier presentation's or `null` for an e-mail, which shows none;
	 * given, the brand is not read again.
	 */
	readonly brand?: InstallationBrand | null
}

/** The presentation of IAM's own page, in the reader's language (else the installation's) and with its logo. */
export async function installationPresentation(services: Services, reader: Reader): Promise<AppPresentation> {
	return { ...readerPresentation(INSTALLATION_PRESENTATION, null, reader), brand: await brandOf(services, reader) }
}

/** An app id is far shorter; a longer query value names no application and is not looked up. */
const MAX_APP_ID_LENGTH = 200

/**
 * The presentation of `app`, which is a hint from a query or a form, or a stored row's app. It names an application only
 * when IAM knows one by that id — a reconciled locale or display name, or a registered return origin — and is the
 * installation's otherwise. It decides words and the landing, never authority: the landing is a registered origin, so a
 * forged `app` can only pick another registered application's language and address. The language is the reader's
 * where one is known, else the application's (`chooseLocale`).
 */
export async function presentationFor(services: Services, app: string | null, reader: Reader): Promise<AppPresentation> {
	if (app === null || app === '' || app.length > MAX_APP_ID_LENGTH) {
		return installationPresentation(services, reader)
	}
	const [row, landing, brand] = await Promise.all([
		services.repositories.appSchema.getPresentation(app),
		registeredLanding(services, app),
		brandOf(services, reader),
	])
	if (row === null && landing === null) {
		return { ...readerPresentation(INSTALLATION_PRESENTATION, null, reader), brand }
	}
	const declared = parsePresentation(row)
	return readerPresentation(
		{ app, locale: DEFAULT_LOCALE, personLocale: null, displayName: declared.displayName, landing, brand },
		declared.locale,
		reader,
	)
}

function brandOf(services: Services, reader: Reader): Promise<InstallationBrand | null> {
	return reader.brand === undefined ? installationBrand(services) : Promise.resolve(reader.brand)
}

/** `presentation` in the person's own `locale`, when there is one; unchanged for none. */
export function withPersonLocale(presentation: AppPresentation, locale: Locale | null): AppPresentation {
	return locale === null ? presentation : { ...presentation, personLocale: locale, locale }
}

/** `presentation` speaking to `reader`: the person's stored language, the request's hints, then the application's. */
function readerPresentation(presentation: AppPresentation, appLocale: Locale | null, reader: Reader): AppPresentation {
	const request = requestLocales(reader.request)
	const person = parseLocale(reader.locale) ?? request.hint ?? request.remembered
	return { ...presentation, personLocale: person, locale: chooseLocale({ person, app: appLocale, browser: request.browser }) }
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

/**
 * The query a link or a form carries so the next page speaks for the same application and in the same person's
 * language: `?app=` and, where the reader's own language is known, `locale=`. Empty for neither.
 */
export function appQuery(presentation: AppPresentation): string {
	const query = new URLSearchParams()
	if (presentation.app !== null) query.set('app', presentation.app)
	if (presentation.personLocale !== null) query.set(LOCALE_PARAM, presentation.personLocale)
	const text = query.toString()
	return text === '' ? '' : `?${text}`
}

/**
 * The query that carries only the reader's own language (`?locale=`), for a link or a form to a page whose application
 * travels elsewhere: IAM's sign-in, whose `?app=` names a handoff. Empty when the words follow the application.
 */
export function localeQuery(presentation: AppPresentation): string {
	return presentation.personLocale === null ? '' : `?${new URLSearchParams({ [LOCALE_PARAM]: presentation.personLocale })}`
}
