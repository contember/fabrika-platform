import type { PasskeyAssertion, PasskeyChallenge, PasskeyRequestOptions } from '@fabrika/iam-contract'
import { useState } from 'react'
import { ApiError } from '../lib/api'
import { browserCredentials, ceremonyFailure, type PasskeyCredentials, stepUpWithPasskey } from '../lib/webauthn'

/**
 * "Verify with a passkey": asks the caller's `fetchChallenge` for a challenge bound to whatever it guards, lets the person
 * answer it with one of their passkeys, and hands the assertion to `onAsserted`, which sends it with the change. IAM
 * verifies it once; the prompt decides nothing. A failure, the change's included, is announced in an alert.
 */
export function StepUpPrompt({ fetchChallenge, onAsserted, label = 'Verify with a passkey', credentials = browserCredentials() }: {
	fetchChallenge: () => Promise<PasskeyChallenge<PasskeyRequestOptions>>
	onAsserted: (assertion: PasskeyAssertion) => Promise<void>
	label?: string
	credentials?: PasskeyCredentials | null
}) {
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<string | null>(null)

	if (credentials === null) {
		return <p className="notice notice-bad" role="alert">This browser cannot use passkeys, so this step cannot be confirmed here.</p>
	}

	async function verify(available: PasskeyCredentials) {
		setBusy(true)
		setFailure(null)
		try {
			const assertion = await stepUpWithPasskey(available, fetchChallenge)
			await onAsserted(assertion)
		} catch (cause) {
			setFailure(cause instanceof ApiError ? cause.message : ceremonyFailure(cause))
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="step-up">
			<button type="button" disabled={busy} aria-busy={busy} onClick={() => void verify(credentials)}>
				{busy ? 'Waiting for your passkey…' : label}
			</button>
			{failure !== null && <p className="error-text" role="alert">{failure}</p>}
		</div>
	)
}
