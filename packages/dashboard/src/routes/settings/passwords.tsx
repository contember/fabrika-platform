import { createPage } from '@buzola/router'
import type { PasswordPolicyDto } from '@fabrika/iam-contract'
import { useState } from 'react'
import { api as iam } from '../../access/lib/api'
import { ApiError } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import { type MinLengthRisk, minLengthRisk, typedMinLength } from '../../lib/password-policy'

/**
 * The installation's minimum password length (ADR-0020). IAM keeps it and applies it to every password chosen after a
 * change, for every person of the installation; a stored password is never judged again.
 */
export default createPage()
	.loader(async () => ({ current: await iam.passwordPolicy.get() }))
	.route('/settings/passwords')
	.render(({ data, invalidate }) => (
		<>
			<div className="page-head">
				<h1>Passwords</h1>
				<p className="hint">
					The shortest password anyone of this installation may choose; passwords already set stay as they are.
				</p>
			</div>
			<PasswordPolicyEditor current={data.current} onSaved={invalidate} />
		</>
	))

export function PasswordPolicyEditor({ current, onSaved }: { current: PasswordPolicyDto; onSaved: () => void }) {
	const [raw, setRaw] = useState(String(current.minLength))
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<string | null>(null)
	/** The minimum IAM answered the last save with, until the field changes again. */
	const [saved, setSaved] = useState<number | null>(null)
	const typed = typedMinLength(raw, current)
	const shown = typed.ok ? typed.value : current.minLength
	const changed = typed.ok && typed.value !== current.minLength

	async function save(minLength: number) {
		setBusy(true)
		setFailure(null)
		setSaved(null)
		try {
			const stored = await iam.passwordPolicy.set({ minLength })
			setRaw(String(stored.minLength))
			setSaved(stored.minLength)
			onSaved()
		} catch (cause) {
			setFailure(cause instanceof ApiError ? cause.message : 'The minimum could not be saved.')
		}
		setBusy(false)
	}

	return (
		<>
			{!current.passwordEnabled && (
				<p className="notice" role="status">
					Password sign-in is off on this installation. The minimum applies once it is turned on.
				</p>
			)}
			<section aria-labelledby="passwords-minimum">
				<h2 id="passwords-minimum">Minimum length</h2>
				<form
					className="form"
					onSubmit={(event) => {
						event.preventDefault()
						if (typed.ok && changed) void save(typed.value)
					}}
				>
					<label>
						Characters<input
							id="passwords-min-length"
							type="number"
							inputMode="numeric"
							min={current.minLengthFloor}
							max={current.maxLength}
							step={1}
							value={raw}
							onChange={(event) => {
								setRaw(event.currentTarget.value)
								setSaved(null)
							}}
						/>
						<span className="hint">
							From {current.minLengthFloor} to {current.maxLength}. The default is {current.defaultMinLength}.
							{current.minLengthFloor === current.defaultMinLength && ' This installation hashes passwords too cheaply for a shorter minimum.'}
						</span>
					</label>
					{!typed.ok && <p className="error-text" role="alert">{typed.message}</p>}
					<RiskNotice risk={minLengthRisk(shown, current.defaultMinLength)} minLength={shown} defaultMinLength={current.defaultMinLength} />
					{failure !== null && <p className="error-text" role="alert">{failure}</p>}
					<div className="form-actions">
						<button className="primary" type="submit" disabled={busy || !changed}>{busy ? 'Saving…' : 'Save minimum'}</button>
						{current.minLength !== current.defaultMinLength && (
							<button
								className="ghost"
								type="button"
								disabled={busy}
								onClick={() => void save(current.defaultMinLength)}
							>
								Use the default ({current.defaultMinLength})
							</button>
						)}
					</div>
				</form>
				{saved !== null && (
					<p className="notice" role="status">
						Saved. The next password anyone chooses needs at least {saved} characters.
					</p>
				)}
				{current.updatedAt !== null && !changed && <p className="hint">Changed {fmtDate(current.updatedAt)}.</p>}
			</section>
		</>
	)
}

function RiskNotice({ risk, minLength, defaultMinLength }: { risk: MinLengthRisk; minLength: number; defaultMinLength: number }) {
	if (risk === 'none') return null
	if (risk === 'below-default') {
		return (
			<p className="notice" role="note">
				Shorter than the recommended {defaultMinLength}. A password is the only factor here, and a{' '}
				{minLength}-character one is weaker against a leaked database. Common passwords are still refused.
			</p>
		)
	}
	return (
		<p className="notice notice-bad" role="note">
			Below 8 characters a password guards little on its own: the sign-in throttle slows guessing online, but a leaked database gives the passwords up
			within hours, and the same short password can be tried against every account. Use this only where that risk is accepted, and let administrators
			sign in with single sign-on where you can.
		</p>
	)
}
