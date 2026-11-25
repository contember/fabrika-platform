import { createPage } from '@buzola/router'
import {
	MAX_PASSKEY_LABEL_LENGTH,
	PASSKEY_REGISTRATION_BINDING,
	type PasskeyAssertion,
	type PasskeyDto,
	passkeyRemovalBinding,
} from '@fabrika/iam-contract'
import { useState } from 'react'
import { api as iam } from '../../access/lib/api'
import { StepUpPrompt } from '../../components/StepUpPrompt'
import { EmptyState } from '../../components/Table'
import { ApiError } from '../../lib/api'
import { fmtAgo, fmtDate } from '../../lib/format'
import { browserCredentials, ceremonyFailure, createPasskey, type PasskeyCredentials, stepUpWithPasskey } from '../../lib/webauthn'

/**
 * The signed-in person's passkeys, which IAM keeps. A passkey confirms a sensitive step in this console, such as deciding
 * an approval that asks for one. Adding another passkey and removing one each take a check with a passkey already held.
 */
export default createPage()
	.loader(async () => ({ passkeys: (await iam.passkeys.list()).items }))
	.route('/account/passkeys')
	.render(({ data, invalidate }) => (
		<>
			<div className="page-head">
				<h1>Passkeys</h1>
				<p className="hint">Passkeys confirm sensitive steps in this console, such as deciding an approval that asks for one.</p>
			</div>
			<Passkeys passkeys={data.passkeys} onChanged={invalidate} />
		</>
	))

export function Passkeys({ passkeys, onChanged, credentials = browserCredentials() }: {
	passkeys: PasskeyDto[]
	onChanged: () => void
	credentials?: PasskeyCredentials | null
}) {
	const [notice, setNotice] = useState<string | null>(null)
	return (
		<>
			{credentials === null && (
				<p className="notice notice-bad" role="alert">This browser cannot use passkeys. Open the console in a browser that supports them to add one.</p>
			)}
			<section aria-labelledby="passkeys-list">
				<h2 id="passkeys-list">Your passkeys</h2>
				{passkeys.length === 0
					? <EmptyState title="No passkey yet" body="Add one to confirm sensitive steps, such as deciding an approval that asks for a passkey." />
					: (
						<ul className="user-access-list">
							{passkeys.map((passkey) => (
								<PasskeyItem
									key={passkey.id}
									passkey={passkey}
									credentials={credentials}
									onRemoved={() => {
										setNotice(`Removed “${passkey.label}”.`)
										onChanged()
									}}
								/>
							))}
						</ul>
					)}
				{notice !== null && <p className="notice" role="status">{notice}</p>}
			</section>
			{credentials !== null && (
				<AddPasskey
					hasPasskey={passkeys.length > 0}
					credentials={credentials}
					onAdded={(label) => {
						setNotice(`Added “${label}”.`)
						onChanged()
					}}
				/>
			)}
		</>
	)
}

function PasskeyItem({ passkey, credentials, onRemoved }: { passkey: PasskeyDto; credentials: PasskeyCredentials | null; onRemoved: () => void }) {
	const [removing, setRemoving] = useState(false)
	return (
		<li className="user-access-item">
			<div className="user-item-row">
				<div className="user-item-title">
					<strong>{passkey.label}</strong>
					<span className="muted small" title={fmtDate(passkey.createdAt)}>
						Added {fmtAgo(passkey.createdAt)} · {passkey.lastUsedAt === null ? 'not used yet' : `last used ${fmtAgo(passkey.lastUsedAt)}`}
					</span>
				</div>
				{!removing && (
					<button type="button" className="small danger" disabled={credentials === null} onClick={() => setRemoving(true)}>
						Remove <span className="sr-only">{passkey.label}</span>
					</button>
				)}
			</div>
			{removing && (
				<div className="user-item-detail">
					<p>Confirm with one of your passkeys to remove “{passkey.label}”. Without a passkey, sensitive steps that ask for one cannot be confirmed.</p>
					<div className="form-actions">
						<StepUpPrompt
							label="Confirm with a passkey and remove"
							credentials={credentials}
							fetchChallenge={() => iam.passkeys.challenge({ binding: passkeyRemovalBinding(passkey.id) })}
							onAsserted={async (stepUp) => {
								await iam.passkeys.remove({ passkeyId: passkey.id, stepUp })
								onRemoved()
							}}
						/>
						<button type="button" className="ghost" onClick={() => setRemoving(false)}>Cancel</button>
					</div>
				</div>
			)}
		</li>
	)
}

/** Register a passkey: a check with a passkey already held first, when there is one, then the browser's create prompt. */
export async function addPasskey(
	credentials: PasskeyCredentials,
	client: Pick<typeof iam.passkeys, 'registrationOptions' | 'register' | 'challenge'>,
	label: string,
	hasPasskey: boolean,
): Promise<PasskeyDto> {
	const stepUp: PasskeyAssertion | undefined = hasPasskey
		? await stepUpWithPasskey(credentials, () => client.challenge({ binding: PASSKEY_REGISTRATION_BINDING }))
		: undefined
	const issued = await client.registrationOptions()
	const credential = await createPasskey(credentials, issued.options)
	return client.register(
		stepUp === undefined ? { challengeId: issued.challengeId, label, credential } : { challengeId: issued.challengeId, label, credential, stepUp },
	)
}

function AddPasskey(
	{ hasPasskey, credentials, onAdded }: { hasPasskey: boolean; credentials: PasskeyCredentials; onAdded: (label: string) => void },
) {
	const [label, setLabel] = useState('')
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<string | null>(null)
	const trimmed = label.trim()

	async function add() {
		setBusy(true)
		setFailure(null)
		try {
			const added = await addPasskey(credentials, iam.passkeys, trimmed, hasPasskey)
			setLabel('')
			onAdded(added.label)
		} catch (cause) {
			setFailure(cause instanceof ApiError ? cause.message : ceremonyFailure(cause))
		} finally {
			setBusy(false)
		}
	}

	return (
		<section aria-labelledby="passkeys-add">
			<h2 id="passkeys-add">Add a passkey</h2>
			<form
				className="form"
				onSubmit={(event) => {
					event.preventDefault()
					if (trimmed !== '') void add()
				}}
			>
				<label>
					Name<input
						id="passkey-label"
						value={label}
						maxLength={MAX_PASSKEY_LABEL_LENGTH}
						placeholder="Work laptop"
						onChange={(event) => setLabel(event.currentTarget.value)}
					/>
					<span className="hint">
						{hasPasskey
							? 'Your browser asks for a passkey you already have first, then for the new one.'
							: 'Your browser asks you to create the passkey on this device, a phone or a security key.'}
					</span>
				</label>
				{failure !== null && <p className="error-text" role="alert">{failure}</p>}
				<div className="form-actions">
					<button className="primary" type="submit" disabled={busy || trimmed === ''} aria-busy={busy}>
						{busy ? 'Waiting for your passkey…' : 'Add passkey'}
					</button>
				</div>
			</form>
		</section>
	)
}
