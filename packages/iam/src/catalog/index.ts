// IAM's words, per language: every page it renders for a person and its own e-mails. A string is plain text; the page
// or the template that inserts it escapes it. `catalogs` must name every locale and each one every key, so a missing
// translation fails the typecheck.

import type { Locale, MessageKind } from '@fabrika/auth-core'
import type { AuthFailure } from '../auth/failure'
import type { PasswordProblem } from '../password-policy'
import { cs } from './cs'
import { en } from './en'

export interface PageText {
	/** The words before fabrika's mark and name in the footer of every page: "Runs on [mark] fabrika". */
	readonly runsOn: string
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
	/** A handoff a browser already signed in here may continue, or end to sign in with another account. */
	readonly chooseAccount: {
		readonly title: (appName: string | null) => string
		/** Followed by the account's label. */
		readonly signedInAs: string
		readonly continueAs: (label: string) => string
		readonly another: string
		/** Another account ends this login, and every app session made from it. */
		readonly anotherNote: string
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
	readonly failure: {
		readonly title: string
		readonly text: (failure: AuthFailure) => string
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
	/** Enrolling this browser as a shared terminal (ADR-0067): the administrator's form, and the page that ends it. */
	readonly terminal: {
		readonly enrolTitle: string
		/** Enrolling signs the administrator out of this browser. */
		readonly enrolText: string
		readonly label: string
		readonly labelProblem: (max: number) => string
		readonly submit: string
		readonly enrolledTitle: string
		readonly enrolledText: (label: string) => string
	}
	readonly invitation: {
		readonly title: string
		readonly text: string
		readonly submit: string
		/** The set-password form of an invitation that creates its principal; `address` is the invited mailbox. */
		readonly createTitle: string
		readonly createText: (address: string) => string
		readonly createSubmit: string
		/** A browser signed in here as someone else opened an invitation that creates a new account for `address`. */
		readonly otherAccountTitle: string
		readonly otherAccountText: (address: string) => string
		readonly signOut: string
		readonly signInFirstTitle: string
		readonly signInFirstText: string
		readonly signIn: string
		readonly unavailableTitle: string
		readonly accountCannotAccept: string
		readonly wrongAddressTitle: string
		readonly wrongAddressText: string
		readonly inviterCannotGrant: string
		/** An external principal and a role not declared external (ADR-0051). */
		readonly roleNotEligible: string
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
 * builds the action URL itself, and a template places it. `expiresAt` is the link's expiry in seconds since the epoch.
 */
export interface MessageValues {
	readonly invitation: {
		readonly appName: string
		readonly role: string
		readonly scope: string
		readonly recipient: string
		readonly inviterLabel: string
		/** The invited person's company, as the inviting application names it; empty when the invitation names none. */
		readonly companyLabel: string
		/** The inviter's personal message; empty when the invitation carries none. */
		readonly message: string
		readonly actionUrl: string
		readonly expiresAt: number
	}
	readonly enrollment: PasswordActionValues
	readonly reset: PasswordActionValues
}

export interface PasswordActionValues {
	/** The application the action returns to; `null` for an action on the installation itself. */
	readonly appName: string | null
	readonly recipient: string
	readonly actionUrl: string
	readonly expiresAt: number
}

/** One template per message. IAM's catalog supplies a default set per language. */
export type MessageTemplates = { readonly [K in MessageKind]: (values: MessageValues[K]) => RenderedMessage }

/** IAM's words around an application's own wording of a message: the HTML part's button and the expiry. */
export interface ApplicationMailText {
	readonly button: { readonly [K in MessageKind]: string }
	/** `expiresAt` in seconds since the epoch, as the `{{expiry}}` placeholder shows it. */
	readonly expiry: (expiresAt: number) => string
}

export interface Catalog {
	readonly pages: PageText
	readonly messages: MessageTemplates
	readonly applicationMail: ApplicationMailText
}

const catalogs: { readonly [L in Locale]: Catalog } = { en, cs }

export function catalogFor(locale: Locale): Catalog {
	return catalogs[locale]
}
