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
					case 'second_factor_expired':
						return 'Your sign-in expired before the code was entered. Sign in again.'
					case 'second_factor_not_allowed':
						return 'Sign in with an administrator account to set up two-step sign-in.'
					case 'second_factor_unavailable':
						return 'Two-step sign-in is unavailable. Try again later.'
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
		secondFactor: {
			challengeTitle: 'Two-step sign-in',
			challengeText: 'Enter the 6-digit code from your authenticator app, or one of your recovery codes.',
			codeLabel: 'Code',
			submit: 'Verify',
			invalidCode: 'This code is not valid. Enter the current code, or a recovery code you have not used.',
			throttled: 'Too many wrong codes. Wait 15 minutes, then try again.',
			appCodesUnavailable: 'Codes from the authenticator app cannot be checked here right now. Use a recovery code, or ask an administrator.',
			startOver: 'Sign in again',
			enrolTitle: 'Set up two-step sign-in',
			enrolText:
				'After the password or single sign-on, every sign-in to this account will ask for a code from an authenticator app on your phone. You will also get recovery codes for when the phone is not at hand.',
			start: 'Set up an authenticator app',
			scanText: 'Scan the QR code with your authenticator app, or type the key into it. Then enter the 6-digit code it shows.',
			secretLabel: 'Key',
			confirmLabel: 'Code from the app',
			confirm: 'Turn on two-step sign-in',
			enrolledTitle: 'Two-step sign-in is on',
			enrolledText: (enrolledOn, left) =>
				`Since ${enrolledOn} every sign-in to this account asks for a code. Recovery codes left: ${left}. To move to a new phone, ask an administrator to reset your authenticator.`,
			recoveryTitle: 'Save your recovery codes',
			recoveryText:
				'Each code signs you in once when your phone is not at hand. They are shown only now: store them somewhere safe, apart from your phone.',
			continue: 'Continue',
			unavailableTitle: 'Two-step sign-in is unavailable',
			unavailableText: 'This installation cannot store authenticator keys yet. Ask its operator to set it up.',
		},
		account: {
			title: 'Your account',
			connectionsTitle: 'Connected agents and devices',
			connectionsText:
				'Each of these acts as you, with your own permissions, until it ends. Revoking one stops it within five minutes; what it already changed stays.',
			none: 'Nothing is connected to your account.',
			agent: (label) => (label === null ? 'An agent that gave no name' : `Agent “${label}”`),
			agentWords: "The name is the agent's own words; nothing checks it.",
			commandLine: 'The fabrika command-line client',
			client: (clientId) => `Client ${clientId}`,
			reaches: 'Reaches',
			mode: (mode) => (mode === 'read' ? 'Reads what you can read, and changes nothing' : 'Acts as you, including changes'),
			scopes: 'Scopes',
			allowed: 'Allowed',
			ends: 'Ends',
			confirmedWith: (passkey) => `Confirmed with the passkey “${passkey}”`,
			confirmedWithRemoved: 'Confirmed with a passkey you have since removed',
			confirmedWithUnrecorded: 'Confirmed with a passkey',
			revoke: 'Revoke',
			revoked: 'Access revoked. It stops within five minutes.',
			alreadyEnded: 'That access had already ended.',
			more: (shown) => `Showing the ${shown} most recent.`,
			onThisPage: 'On this page',
			holder: 'Agent or device',
			lastActive: 'Last active',
			notRenewed: 'Not since approval',
			lastActiveText: 'Last active is when it last renewed its access; while in use it renews it every five minutes.',
			details: 'Details',
			endpoints: 'Addresses it can call',
			cliPreset: (preset, app) => {
				const target = app ?? 'every application you may'
				switch (preset) {
					case 'read':
						return `Reads ${target}, and changes nothing`
					case 'deploy':
						return `Reads and deploys ${target}`
					case 'operate':
						return `Deploys ${target}, and manages its secrets and settings`
					case 'create':
						return 'Registers applications, and changes or deletes any you may manage'
				}
			},
			revokeLabel: (holder, reaches, allowed) => `Revoke ${holder} at ${reaches}, allowed ${allowed}`,
			revokeTitle: 'Revoke this access?',
			revokeConfirm: (holder, reaches) => `${holder}: access to ${reaches} ends within five minutes. What it already changed stays.`,
			cancel: 'Cancel',
		},
		passkeys: {
			title: 'Passkeys',
			text: 'A passkey confirms a sensitive step, such as deciding an approval in the console. It does not sign you in.',
			none: 'You have no passkey.',
			added: 'Added',
			lastUsed: 'Last used',
			neverUsed: 'Never used',
			remove: 'Remove',
			removeLabel: (label) => `Remove the passkey “${label}”`,
			addTitle: 'Add a passkey',
			label: 'Name',
			labelHint: 'For example the device or the password manager that keeps it.',
			add: 'Add a passkey',
			addedNotice: 'Passkey added.',
			removedNotice: 'Passkey removed.',
			refusedNotice: 'The passkey check did not pass, or it expired. Nothing changed; try again.',
			busyNotice: 'Too many passkey checks are open. Try again in a few minutes.',
			duplicateNotice: 'That passkey is registered already.',
			limitNotice: 'You keep the most passkeys a person can. Remove one first.',
			labelNotice: 'Give the passkey a name.',
			confirmTitle: 'Confirm with a passkey',
			confirmAddText: 'You have a passkey already, so adding another takes a check with one you have.',
			confirmRemoveText: (label) => `Removing the passkey “${label}” takes a check with one of your passkeys.`,
			createTitle: 'Create the passkey',
			createText: (label) => `Your browser asks your device or password manager to create the passkey “${label}”.`,
			continue: 'Continue with a passkey',
			unsupported: 'This browser cannot use passkeys.',
			failed: 'The passkey check did not finish. Try again.',
			back: 'Back to your account',
			stepUpTitle: 'Confirm with your passkey',
			stepUpText:
				'The console asks you to confirm a step with one of your passkeys: deciding an approval, or changing how an environment is protected. Confirm only if you have just started it.',
			stepUpDone: 'Confirmed. Close this tab and continue in the console.',
			stepUpGone: 'This check expired or was used already. Close this tab and start again in the console.',
			stepUpRefused: 'The passkey was not accepted. Close this tab and start again in the console.',
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
