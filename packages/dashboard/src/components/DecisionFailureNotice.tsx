import { Link } from '@buzola/router'
import type { StepUpMode } from '../lib/api'
import type { DecisionFailure } from '../lib/decision-step-up'

/** Why a decision was not recorded, announced; a person without a passkey is pointed to where they register one. */
export function DecisionFailureNotice({ failure }: { failure: DecisionFailure }) {
	return (
		<p className="error-text" role="alert">
			{failure.message}
			{failure.noPasskey && (
				<>
					{' '}
					<Link to="account/passkeys">Account → Passkeys</Link>
				</>
			)}
		</p>
	)
}

/** What the page says before a decision that takes a passkey. */
export function StepUpHint({ stepUp, item }: { stepUp: StepUpMode; item: 'deploy' | 'request' }) {
	if (stepUp === 'none') return null
	return <p className="hint">Deciding this {item} takes one of your passkeys: your browser asks for it when you approve or refuse.</p>
}
