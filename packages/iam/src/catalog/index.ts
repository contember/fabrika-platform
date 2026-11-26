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
	/** The second factor (TOTP): the code a sign-in asks for, and enrolling an authenticator app. */
	readonly secondFactor: {
		readonly challengeTitle: string
		readonly challengeText: string
		readonly codeLabel: string
		readonly submit: string
		readonly invalidCode: string
		/** Too many wrong codes for this account; the next attempt waits. */
		readonly throttled: string
		/** The data key is unset or does not open the secret: only a recovery code signs in. */
		readonly appCodesUnavailable: string
		readonly startOver: string
		readonly enrolTitle: string
		readonly enrolText: string
		readonly start: string
		readonly scanText: string
		readonly secretLabel: string
		readonly confirmLabel: string
		readonly confirm: string
		readonly enrolledTitle: string
		/** `enrolledOn` is an ISO date; `left` the recovery codes not used yet. */
		readonly enrolledText: (enrolledOn: string, left: number) => string
		readonly recoveryTitle: string
		readonly recoveryText: string
		readonly continue: string
		readonly unavailableTitle: string
		readonly unavailableText: string
	}
	/** The signed-in person's own page (`/auth/account`): what acts as them through an OAuth grant, and its revocation. */
	readonly account: {
		readonly title: string
		readonly connectionsTitle: string
		readonly connectionsText: string
		readonly none: string
		/** An agent's grant at an application (ADR-0090); `label` is the agent's own name for itself, or null. */
		readonly agent: (label: string | null) => string
		readonly agentWords: string
		readonly commandLine: string
		/** Any other client, by its client id. */
		readonly client: (clientId: string) => string
		readonly reaches: string
		/** What an agent grant's mode lets it do, in words. */
		readonly mode: (mode: 'read' | 'write') => string
		readonly scopes: string
		readonly allowed: string
		readonly ends: string
		readonly revoke: string
		readonly revoked: string
		readonly alreadyEnded: string
		/** More grants are live than the page lists; `shown` is how many it lists. */
		readonly more: (shown: number) => string
	}
	/**
	 * A person's passkeys (WebAuthn), on IAM's own pages: the section of the account page, the pages that add and remove
	 * one, and the step-up page a console decision opens.
	 */
	readonly passkeys: {
		readonly title: string
		readonly text: string
		readonly none: string
		readonly added: string
		readonly lastUsed: string
		readonly neverUsed: string
		readonly remove: string
		readonly addTitle: string
		readonly label: string
		readonly labelHint: string
		readonly add: string
		readonly addedNotice: string
		readonly removedNotice: string
		readonly refusedNotice: string
		readonly busyNotice: string
		readonly duplicateNotice: string
		readonly limitNotice: string
		readonly labelNotice: string
		readonly confirmTitle: string
		readonly confirmAddText: string
		/** Removing the passkey named `label` takes a check with one the person holds. */
		readonly confirmRemoveText: (label: string) => string
		readonly createTitle: string
		/** The browser is about to create the passkey the person named `label`. */
		readonly createText: (label: string) => string
		readonly continue: string
		readonly unsupported: string
		readonly failed: string
		readonly back: string
		readonly stepUpTitle: string
		readonly stepUpText: string
		readonly stepUpDone: string
		readonly stepUpGone: string
		readonly stepUpRefused: string
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
