import { useEffect, useRef, useState } from 'react'
import { type DecisionFailure, decisionFailure, type PasskeyCheck } from '../lib/decision-step-up'
import { fmtTimeMs } from '../lib/format'
import { DecisionFailureNotice } from './DecisionFailureNotice'

/**
 * A decision waiting for its passkey check: the person opens IAM's step-up page in a new tab, confirms there, comes back
 * and continues, which posts the decision with the challenge's id. A plain link, not a popup: the console's
 * `Cross-Origin-Opener-Policy: same-origin` severs any handle to a window it opens. Until then the prompt says plainly
 * that nothing is saved, and once the check expires, that it expired and nothing was saved.
 */
export function PasskeyCheckPrompt<T>({ check: issued, onDone, onCancel, describeFailure = decisionFailure }: {
	check: PasskeyCheck<T>
	onDone: (value: T) => void
	onCancel: () => void
	describeFailure?: (cause: unknown) => DecisionFailure
}) {
	const [check, setCheck] = useState(issued)
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<DecisionFailure | null>(null)
	const expired = useExpired(check.expiresAt)
	const lead = useRef<HTMLParagraphElement>(null)
	const unsaved = check.what === 'change' ? 'saved' : 'recorded'

	// The prompt may open below the fold, or after a dialog closed: bring it into view and announce it.
	useEffect(() => {
		lead.current?.scrollIntoView({ block: 'nearest' })
		lead.current?.focus({ preventScroll: true })
	}, [check, expired])

	// Leaving the page while the check waits loses the change, and nothing on the next load would say it was pending.
	useEffect(() => {
		const warn = (event: BeforeUnloadEvent) => event.preventDefault()
		window.addEventListener('beforeunload', warn)
		return () => window.removeEventListener('beforeunload', warn)
	}, [])

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

	async function renew() {
		setBusy(true)
		setFailure(null)
		try {
			setCheck(await check.renew())
		} catch (cause) {
			setFailure(describeFailure(cause))
		}
		setBusy(false)
	}

	const until = fmtTimeMs(check.expiresAt * 1000)
	return (
		<div className="notice passkey-check" role="group" aria-label="Passkey check">
			<div className="passkey-check-body">
				{expired
					? (
						<p ref={lead} tabIndex={-1}>
							<strong>Not {unsaved}.</strong> The passkey check expired at {until}, so nothing was {unsaved}. Start a new check to confirm this {check.what}
							{' '}
							with one of your passkeys.
						</p>
					)
					: (
						<>
							<p ref={lead} tabIndex={-1}>
								<strong>Not {unsaved} yet.</strong> This {check.what} takes one of your passkeys.
							</p>
							<ol className="passkey-check-steps">
								<li>
									Open the passkey check: IAM's page opens in a new tab, where you confirm with a passkey.
								</li>
								<li>Come back here and continue.</li>
							</ol>
							<p className="hint">The check expires at {until}.</p>
						</>
					)}
				<div className="row-actions">
					{expired
						? (
							<button type="button" className="primary" disabled={busy} aria-busy={busy} onClick={() => void renew()}>
								{busy ? 'Starting…' : 'Start a new check'}
							</button>
						)
						: (
							<>
								<a className="btn" href={check.url} target="_blank" rel="noopener noreferrer">Open the passkey check</a>
								<button type="button" className="primary" disabled={busy} aria-busy={busy} onClick={() => void proceed()}>
									{busy ? 'Recording…' : 'Continue'}
								</button>
							</>
						)}
					<button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
				</div>
				{failure !== null && <PasskeyCheckFailure failure={failure} />}
			</div>
		</div>
	)
}

/** Whether a check past `expiresAt` (epoch seconds) expired; turns true at that moment while the page is open. */
function useExpired(expiresAt: number): boolean {
	const [expired, setExpired] = useState(() => Date.now() >= expiresAt * 1000)
	useEffect(() => {
		const left = expiresAt * 1000 - Date.now()
		setExpired(left <= 0)
		if (left <= 0) return
		const timer = setTimeout(() => setExpired(true), left)
		return () => clearTimeout(timer)
	}, [expiresAt])
	return expired
}

/** Why Continue recorded nothing. IAM spends a check on its first use, so one confirmed already cannot be continued again. */
export function PasskeyCheckFailure({ failure }: { failure: DecisionFailure }) {
	return (
		<>
			<DecisionFailureNotice failure={failure} />
			<p className="hint">A passkey check works once. If you confirmed it already, cancel and start again.</p>
		</>
	)
}
