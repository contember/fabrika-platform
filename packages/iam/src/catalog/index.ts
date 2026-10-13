// IAM's words, per language: every page it renders for a person and its own e-mails. A string is plain text; the page
// or the template that inserts it escapes it. `catalogs` must name every locale and each one every key, so a missing
// translation fails the typecheck.

import type { Locale } from '@fabrika/auth-core'
import type { PasswordProblem } from '../password-policy'
import { cs } from './cs'
import { en } from './en'

export interface PageText {
	readonly showPassword: string
	readonly hidePassword: string
	readonly email: string
	readonly signIn: {
		/** The page title and heading; `appName` is the application the login hands off to, if it declares one. */
		readonly title: (appName: string | null) => string
		readonly password: string
		readonly submit: string
		readonly forgot: string
		readonly singleSignOn: string
		readonly invalidCredentials: string
	}
	readonly forgot: {
		readonly title: string
		readonly intro: (appName: string | null) => string
		readonly submit: string
		readonly sentTitle: string
		readonly sentText: string
		readonly back: string
	}
	readonly setPassword: {
		readonly title: (purpose: 'enrollment' | 'reset') => string
		readonly rule: (min: number, max: number) => string
		/** The password belongs to the person's account on the installation, not to the application. */
		readonly shared: (appName: string | null) => string
		readonly newPassword: string
		readonly problem: (problem: PasswordProblem, min: number, max: number) => string
	}
	readonly invalidLink: {
		readonly title: string
		readonly text: string
		readonly requestNew: string
	}
	readonly logout: {
		readonly title: string
		readonly text: string
		readonly submit: string
	}
	readonly invitation: {
		readonly title: string
		readonly text: string
		readonly submit: string
		readonly signInFirstTitle: string
		readonly signInFirstText: string
		readonly signIn: string
		readonly unavailableTitle: string
		readonly accountCannotAccept: string
		readonly wrongAddressTitle: string
		readonly wrongAddressText: string
		readonly inviterCannotGrant: string
		readonly acceptedTitle: string
		readonly acceptedText: (values: { readonly role: string; readonly scope: string; readonly appName: string }) => string
		readonly invalidTitle: string
		readonly invalidText: string
	}
}

/** A rendered e-mail: the subject and both bodies, from the same values. */
export interface RenderedMessage {
	readonly subject: string
	readonly text: string
	readonly html: string
}

/**
 * The closed set of values each IAM message is rendered from. Every value is plain text; a template escapes it. IAM
 * builds the action URL itself, and a template places it.
 */
export interface MessageValues {
	readonly invitation: {
		readonly appName: string
		readonly role: string
		readonly scope: string
		readonly actionUrl: string
	}
	readonly enrollment: PasswordActionValues
	readonly reset: PasswordActionValues
}

export interface PasswordActionValues {
	/** The application the action returns to; `null` for an action on the installation itself. */
	readonly appName: string | null
	readonly actionUrl: string
}

export type MessageKind = keyof MessageValues

/** One template per message. IAM's catalog supplies a default set per language. */
export type MessageTemplates = { readonly [K in MessageKind]: (values: MessageValues[K]) => RenderedMessage }

export interface Catalog {
	readonly pages: PageText
	readonly messages: MessageTemplates
}

const catalogs: { readonly [L in Locale]: Catalog } = { en, cs }

export function catalogFor(locale: Locale): Catalog {
	return catalogs[locale]
}
