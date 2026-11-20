// IAM's words, per language: every page it renders for a person and its own e-mails. A string is plain text; the page
// or the template that inserts it escapes it. `catalogs` must name every locale and each one every key, so a missing
// translation fails the typecheck.

import type { IamMailCatalog, Locale } from '@fabrika/auth-core'
import type { AuthFailure } from '../auth/failure'
import type { PasswordProblem } from '../password-policy'
import { cs } from './cs'
import { en } from './en'
import { uk } from './uk'

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
		/**
		 * No principal holds `address`, this invitation creates none, and no sign-in here would create one: the person
		 * cannot accept on their own. The invitation stays open.
		 */
		readonly noAccountTitle: string
		readonly noAccountText: (address: string) => string
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

/** IAM's words: its pages here, and its e-mails as `@fabrika/auth-core` words them (`iamMailCatalog`). */
export interface Catalog extends IamMailCatalog {
	readonly pages: PageText
}

const catalogs: { readonly [L in Locale]: Catalog } = { en, cs, uk }

export function catalogFor(locale: Locale): Catalog {
	return catalogs[locale]
}
