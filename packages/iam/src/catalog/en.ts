import { iamMailCatalog } from '@fabrika/auth-core'
import type { Catalog } from './index'

export const en: Catalog = {
	pages: {
		runsOn: 'Runs on',
		showPassword: 'Show',
		hidePassword: 'Hide',
		email: 'Email',
		signIn: {
			title: (appName) => (appName === null ? 'Sign in' : `Sign in to ${appName}`),
			password: 'Password',
			submit: 'Sign in',
			forgot: 'Forgot password?',
			singleSignOn: 'Continue with single sign-on',
			invalidCredentials: 'Invalid email or password.',
		},
		chooseAccount: {
			title: (appName) => (appName === null ? 'Continue to the application' : `Continue to ${appName}`),
			signedInAs: 'You are signed in as',
			continueAs: (label) => `Continue as ${label}`,
			another: 'Use another account',
			anotherNote: 'Using another account signs this browser out of every application it is signed in to with this account.',
		},
		forgot: {
			title: 'Reset password',
			intro: (appName) =>
				appName === null
					? 'Enter the address you sign in with.'
					: `Enter the address you sign in to ${appName} with.`,
			submit: 'Continue',
			sentTitle: 'Request received',
			sentText: 'If the account can use password sign-in and email delivery succeeds, a one-time link will arrive.',
			back: 'Return to sign in',
		},
		setPassword: {
			title: (purpose) => (purpose === 'enrollment' ? 'Set your password' : 'Reset your password'),
			rule: (min, max) => `Use ${min}–${max} characters. Long passphrases are welcome.`,
			shared: (appName) =>
				appName === null
					? 'The password belongs to your account on this sign-in service and applies to every application that uses it.'
					: `The password belongs to your account on this sign-in service and applies to every application that uses it, not only to ${appName}.`,
			newPassword: 'New password',
			problem: (problem, min, max) => {
				switch (problem) {
					case 'too_short':
						return `Use at least ${min} characters.`
					case 'too_long':
						return `Use at most ${max} characters.`
					case 'guessable':
						return 'Choose a password that is not based on your account details or a common password.'
				}
			},
		},
		failure: {
			title: 'Authentication error',
			text: (failure) => {
				switch (failure.kind) {
					case 'no_return_address':
						return 'No return address was given for this app.'
					case 'no_handoff_proof':
						return 'No valid browser handoff proof was given for this app.'
					case 'unregistered_origin':
						return `${failure.origin} is not a registered return origin for this app.`
					case 'password_disabled':
						return 'Password sign-in is disabled.'
					case 'oidc_disabled':
						return 'Single sign-on is disabled.'
					case 'cross_origin':
						return 'Invalid request origin.'
					case 'malformed_form':
						return 'Invalid form.'
					case 'login_unavailable':
						return 'Sign-in is unavailable. Try again later.'
					case 'logout_unavailable':
						return 'Sign-out is unavailable. Try again later.'
					case 'oidc_invalid_state':
						return 'The single sign-on attempt is invalid or expired. Sign in again.'
					case 'oidc_exchange_failed':
						return 'The identity provider did not complete the sign-in.'
					case 'oidc_invalid_id_token':
						return 'The identity provider answered with an invalid identity.'
					case 'not_admitted':
						return 'This account may not sign in here.'
					case 'login_refused':
						return `Sign-in was refused (${failure.reason}).`
					case 'terminal_enrolment_not_allowed':
						return 'Sign in with an account that may enrol terminals.'
					case 'terminal_enrolment_unavailable':
						return 'Enrolment is unavailable. Try again later.'
					case 'terminal_completion_refused':
						return 'This sign-in has expired or was already used. Identify again.'
				}
			},
		},
		invalidLink: {
			title: 'Link unavailable',
			text: 'This link is invalid, expired, or already used.',
			requestNew: 'Request a new link',
		},
		logout: {
			title: 'Sign out',
			text: 'This ends your session on every application you are signed in to.',
			submit: 'Sign out',
		},
		terminal: {
			enrolTitle: 'Enrol this computer as a terminal',
			enrolText:
				'People will sign in on this computer through the applications it is set up for. Enrolling signs you out of this browser, so the terminal is never left signed in as you.',
			label: 'Name of the terminal',
			labelProblem: (max) => `Use 1–${max} characters.`,
			submit: 'Enrol and sign out',
			enrolledTitle: 'Terminal enrolled',
			enrolledText: (label) => `This browser is now the terminal ${label}. You are signed out. An administrator sets which applications it serves.`,
		},
		invitation: {
			title: 'Accept invitation',
			text:
				'Accept the invitation. The next step asks you to sign in with the invited address, or to choose a password when the invitation creates your account.',
			submit: 'Accept invitation',
			createTitle: 'Choose your password',
			createText: (address) => `Your account signs in with ${address} and the password you choose here. Choosing it accepts the invitation.`,
			createSubmit: 'Set password and accept',
			otherAccountTitle: 'Signed in with another account',
			otherAccountText: (address) =>
				`This invitation creates a new account for ${address}, and this browser is signed in with another account. Sign out first, or open the invitation link in another browser profile.`,
			signOut: 'Sign out',
			signInFirstTitle: 'Sign in first',
			signInFirstText: 'Sign in with the invited address, then open the invitation link again.',
			signIn: 'Sign in',
			noAccountTitle: 'No account for this address',
			noAccountText: (address) =>
				`There is no account for ${address} here, and this invitation does not create one. Ask the person who invited you to have an account set up for this address, then open the invitation link again.`,
			unavailableTitle: 'Invitation unavailable',
			accountCannotAccept: 'This account cannot accept invitations.',
			wrongAddressTitle: 'Invitation for another address',
			wrongAddressText: 'You are signed in with an address this invitation was not sent to. Sign in with the invited address.',
			inviterCannotGrant: 'The person who sent this invitation can no longer give this role. Ask for a new invitation.',
			roleNotEligible: 'This account cannot hold the role this invitation gives. Ask the person who sent it.',
			acceptedTitle: 'Invitation accepted',
			acceptedText: ({ role, scope, appName }) => `You are now ${role} of a ${scope} of ${appName}.`,
			invalidTitle: 'Link unavailable',
			invalidText:
				'This invitation is invalid, expired, cancelled or already used. If you have not accepted it yet, ask the person who invited you to send it again.',
		},
	},
	...iamMailCatalog('en'),
}
