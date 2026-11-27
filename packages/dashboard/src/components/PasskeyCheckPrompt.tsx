import { useEffect, useReducer, useRef, useState } from 'react'
import { type DecisionFailure, decisionFailure, type PasskeyCheck } from '../lib/decision-step-up'
import { fmtTimeMs } from '../lib/format'
import { DecisionFailureNotice } from './DecisionFailureNotice'

/**
 * A decision waiting for its passkey check, which says plainly that nothing is saved yet, how to finish and until when.
 * IAM's page opens through a plain link: the console's `Cross-Origin-Opener-Policy: same-origin` severs a popup's handle.
 */
export function PasskeyCheckPrompt<T>({ check: issued, onDone, onCancel, describeFailure = decisionFailure }: {
	check: PasskeyCheck<T>
	onDone: (value: T) => void
	onCancel: () => void
	describeFailure?: (cause: unknown) => DecisionFailure
}) {
	const [check, setCheck] = useState(issued)
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<{ readonly of: 'continue' | 'renew'; readonly failure: DecisionFailure } | null>(null)
	const expired = useExpired(check.deadline)
	const lead = useRef<HTMLParagraphElement>(null)
	const unsaved = check.what === 'change' ? 'saved' : 'recorded'

	// The prompt may open below the fold, or after a dialog closed: bring it into view and announce it.
	useEffect(() => {
		lead.current?.scrollIntoView({ block: 'nearest' })
		lead.current?.focus({ preventScroll: true })
	}, [check, expired])

	// A reload or a closed tab loses the waiting change; the next load would not say it was pending.
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
			setFailure({ of: 'continue', failure: describeFailure(cause) })
			setBusy(false)
		}
	}

	async function renew() {
		setBusy(true)
		setFailure(null)
		try {
			setCheck(await check.renew())
		} catch (cause) {
			setFailure({ of: 'renew', failure: describeFailure(cause) })
		}
		setBusy(false)
	}

	const until = fmtTimeMs(check.deadline)
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
				{failure !== null && (failure.of === 'continue'
					? <PasskeyCheckFailure failure={failure.failure} />
					: <DecisionFailureNotice failure={failure.failure} />)}
			</div>
		</div>
	)
}

/**
 * Whether `deadline` (epoch milliseconds) has passed, read at each render; a timer and the tab becoming visible again
 * render once more, since a background tab may run the timer late.
 */
function useExpired(deadline: number): boolean {
	const [, rerender] = useReducer((count: number) => count + 1, 0)
	useEffect(() => {
		const timer = setTimeout(rerender, Math.max(0, deadline - Date.now()))
		document.addEventListener('visibilitychange', rerender)
		return () => {
			clearTimeout(timer)
			document.removeEventListener('visibilitychange', rerender)
		}
	}, [deadline])
	return Date.now() >= deadline
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
