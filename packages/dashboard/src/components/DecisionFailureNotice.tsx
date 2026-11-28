import { Link } from '@buzola/router'
import type { StepUpMode } from '../lib/api'
import type { DecisionFailure } from '../lib/decision-step-up'

/** Why a decision was not recorded, announced; a person without a passkey is pointed to where they add one. */
export function DecisionFailureNotice({ failure }: { failure: DecisionFailure }) {
	return (
		<p className="error-text" role="alert">
			<DecisionFailureText failure={failure} />
		</p>
	)
}

/** The words of a failure, with the link to Account → Passkeys (which leads to IAM's account page) for a person without a passkey. */
export function DecisionFailureText({ failure }: { failure: DecisionFailure }) {
	return (
		<>
			{failure.message}
			{failure.noPasskey && (
				<>
					{' '}
					<Link to="account/passkeys">Account → Passkeys</Link>
				</>
			)}
		</>
	)
}

/** What the page says before a decision that takes a passkey. */
export function StepUpHint({ stepUp, item }: { stepUp: StepUpMode; item: 'deploy' | 'request' | 'plan' }) {
	if (stepUp === 'none') return null
	return (
		<p className="hint">
			Deciding this {item} takes one of your passkeys: when you approve or refuse, the console links to IAM's page, where you confirm it with a passkey.
		</p>
	)
}
