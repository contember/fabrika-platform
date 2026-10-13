import { escapeHtml } from '../html'
import type { Catalog, RenderedMessage } from './index'

export const en: Catalog = {
	pages: {
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
		invitation: {
			title: 'Accept invitation',
			text: 'Accept the invitation with the account you are signed in to here. It must use the invited address.',
			submit: 'Accept invitation',
			signInFirstTitle: 'Sign in first',
			signInFirstText: 'Sign in with the invited address, then open the invitation link again.',
			signIn: 'Sign in',
			unavailableTitle: 'Invitation unavailable',
			accountCannotAccept: 'This account cannot accept invitations.',
			wrongAddressTitle: 'Invitation for another address',
			wrongAddressText: 'You are signed in with an address this invitation was not sent to. Sign in with the invited address.',
			inviterCannotGrant: 'The person who sent this invitation can no longer give this role. Ask for a new invitation.',
			roleNotEligible: 'This account cannot hold the role this invitation gives. Ask the person who sent it.',
			acceptedTitle: 'Invitation accepted',
			acceptedText: ({ role, scope, appName }) => `You are now ${role} of a ${scope} of ${appName}.`,
			invalidTitle: 'Link unavailable',
			invalidText: 'This invitation is invalid, expired, cancelled or already used.',
		},
	},
	messages: {
		invitation: ({ appName, role, scope, actionUrl }) => {
			const what = `${scope} of ${appName} as ${role}`
			return {
				subject: `You are invited to ${appName}`,
				text:
					`You are invited to join a ${what}.\n\nSign in with this address, then open this one-time link to accept:\n\n${actionUrl}\n\nIf you did not expect this, you can ignore this email.`,
				html: `<p>You are invited to join a ${
					escapeHtml(what)
				}.</p><p>Sign in with this address, then open this one-time link to accept:</p><p><a href="${
					escapeHtml(actionUrl)
				}">Accept the invitation</a></p><p>If you did not expect this, you can ignore this email.</p>`,
			}
		},
		enrollment: ({ appName, actionUrl }) =>
			passwordMessage(
				appName === null ? 'Set your Fabrika password' : `Set your password for ${appName}`,
				appName === null ? 'set your Fabrika password' : `set your password for ${appName}`,
				actionUrl,
			),
		reset: ({ appName, actionUrl }) =>
			passwordMessage(
				appName === null ? 'Reset your Fabrika password' : `Reset your password for ${appName}`,
				appName === null ? 'reset your Fabrika password' : `reset your password for ${appName}`,
				actionUrl,
			),
	},
	applicationMail: {
		button: { invitation: 'Accept the invitation', enrollment: 'Set your password', reset: 'Reset your password' },
		expiry: (expiresAt) => `${expiryFormat.format(new Date(expiresAt * 1000))} UTC`,
	},
}

const expiryFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' })

function passwordMessage(subject: string, action: string, actionUrl: string): RenderedMessage {
	return {
		subject,
		text: `Use this one-time link to ${action}:\n\n${actionUrl}\n\nIf you did not request this, you can ignore this email.`,
		html: `<p>Use this one-time link to ${escapeHtml(action)}:</p><p><a href="${escapeHtml(actionUrl)}">${
			escapeHtml(subject)
		}</a></p><p>If you did not request this, you can ignore this email.</p>`,
	}
}
