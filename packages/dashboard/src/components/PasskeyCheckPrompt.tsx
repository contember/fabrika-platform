import { useState } from 'react'
import { type DecisionFailure, decisionFailure, type PasskeyCheck } from '../lib/decision-step-up'
import { DecisionFailureNotice } from './DecisionFailureNotice'

/**
 * A decision waiting for its passkey check: the person opens IAM's step-up page in a new tab, confirms there, comes back
 * and continues, which posts the decision with the challenge's id. A plain link, not a popup: the console's
 * `Cross-Origin-Opener-Policy: same-origin` severs any handle to a window it opens.
 */
export function PasskeyCheckPrompt<T>({ check, onDone, onCancel, describeFailure = decisionFailure }: {
	check: PasskeyCheck<T>
	onDone: (value: T) => void
	onCancel: () => void
	describeFailure?: (cause: unknown) => DecisionFailure
}) {
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<DecisionFailure | null>(null)

	async function proceed() {
		setBusy(true)
		setFailure(null)
		try {
			const value = await check.post()
			onDone(value)
		} catch (cause) {
			setFailure(describeFailure(cause))
			setBusy(false)
		}
	}

	return (
		<div className="passkey-check" role="group" aria-label="Passkey check">
			<p className="hint">
				Confirm this {check.what} with one of your passkeys on IAM's page, then come back and continue.{' '}
				<a href={check.url} target="_blank" rel="noopener noreferrer">Open the passkey check</a>
			</p>
			<div className="row-actions">
				<button type="button" className="primary" disabled={busy} aria-busy={busy} onClick={() => void proceed()}>
					{busy ? 'Recording…' : 'Continue'}
				</button>
				<button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
			</div>
			{failure !== null && <DecisionFailureNotice failure={failure} />}
		</div>
	)
}
