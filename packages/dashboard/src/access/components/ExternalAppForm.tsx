import type { ExternalAppDto, PutExternalAppRequest } from '@fabrika/iam-contract'
import { type ReactNode, useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { ApiError } from '../../lib/api'
import { api } from '../lib/api'
import {
	type ClientDraft,
	draftConsequences,
	draftOf,
	emptyClient,
	emptyDraft,
	type ExternalAppDraft,
	externalAppRequest,
	revocationsToConfirm,
	type RoleDraft,
} from '../lib/external-apps'

/**
 * An external application as one form: the record, its roles and its clients, saved whole with `externalApps.put`.
 * `original` is null when registering a new one; its id is fixed once it exists.
 */
export function ExternalAppForm({ original, onSaved, onCancel, onEdit }: {
	original: ExternalAppDto | null
	onSaved: (saved: ExternalAppDto) => void
	onCancel: () => void
	/** Each change to the draft, so the page can drop what it said about the last save. */
	onEdit?: () => void
}) {
	const [draft, setDraft] = useState<ExternalAppDraft>(() => original === null ? emptyDraft() : draftOf(original))
	const [problems, setProblems] = useState<ReadonlyMap<string, string>>(new Map())
	const [failure, setFailure] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	/** A checked request whose save ends sign-ins, waiting for the person to confirm it. */
	const [confirming, setConfirming] = useState<{ request: PutExternalAppRequest; lines: string[] } | null>(null)
	const consequences = draftConsequences(original, draft)
	const creating = original === null

	function edit(update: (current: ExternalAppDraft) => ExternalAppDraft) {
		setDraft(update)
		onEdit?.()
	}

	function change(next: Partial<ExternalAppDraft>) {
		edit((current) => ({ ...current, ...next }))
	}

	function changeRole(index: number, next: Partial<RoleDraft>) {
		edit((current) => ({ ...current, roles: current.roles.map((role, at) => at === index ? { ...role, ...next } : role) }))
	}

	function changeClient(index: number, next: Partial<ClientDraft>) {
		edit((current) => ({ ...current, clients: current.clients.map((client, at) => at === index ? { ...client, ...next } : client) }))
	}

	async function submit(event: React.FormEvent) {
		event.preventDefault()
		setFailure(null)
		const checked = externalAppRequest(draft)
		if (!checked.ok) {
			setProblems(checked.problems)
			return
		}
		setProblems(new Map())
		const lines = creating ? [] : revocationsToConfirm(consequences)
		if (lines.length > 0) {
			setConfirming({ request: checked.request, lines })
			return
		}
		await save(checked.request)
	}

	/** Sends the save; a refusal is shown in the form, never thrown, so a confirmation closes either way. */
	async function save(request: PutExternalAppRequest) {
		setBusy(true)
		try {
			onSaved(await api.externalApps.put(request))
		} catch (cause) {
			setFailure(cause instanceof ApiError ? cause.message : 'The application could not be saved.')
		} finally {
			setBusy(false)
		}
	}

	return (
		<form className="form wide registry-form" onSubmit={submit} noValidate>
			<fieldset className="registry-group">
				<legend>Application</legend>
				{creating && (
					<Field
						id="external-app-id"
						label="App id"
						problem={problems.get('app')}
						hint="IAM's id for it, in grants and in its tokens. It cannot change later."
					>
						{(state) => (
							<input
								{...state}
								id="external-app-id"
								value={draft.app}
								onChange={(event) => change({ app: event.currentTarget.value })}
								placeholder="ops-tool"
								autoComplete="off"
								spellCheck={false}
								required
								autoFocus
							/>
						)}
					</Field>
				)}
				<Field id="external-app-name" label="Name" problem={problems.get('name')} hint="What people and the console see.">
					{(state) => (
						<input
							id="external-app-name"
							{...state}
							value={draft.name}
							onChange={(event) => change({ name: event.currentTarget.value })}
							required
						/>
					)}
				</Field>
				<Field
					id="external-app-resource"
					label="Resource"
					problem={problems.get('resource')}
					hint="The https URI the application asks IAM for. Its tokens are valid for this audience alone, on none of this installation's hosts."
				>
					{(state) => (
						<input
							{...state}
							id="external-app-resource"
							value={draft.resource}
							onChange={(event) => change({ resource: event.currentTarget.value })}
							placeholder="https://tool.example.com"
							spellCheck={false}
							required
						/>
					)}
				</Field>
				{consequences.resourceChanged && (
					<p className="notice notice-bad" role="note">
						Changing the resource revokes every sign-in of this application's clients. People sign in again.
					</p>
				)}
			</fieldset>

			<fieldset className="registry-group">
				<legend>Roles (optional)</legend>
				<p className="hint">
					Without roles, every active user of the installation signs in. With roles, a person needs one of them, granted in Users; the token names the ones
					they hold.
				</p>
				{problems.has('roles') && <p className="error-text" role="alert">{problems.get('roles')}</p>}
				{draft.roles.length > 0 && (
					<div className="registry-rows" role="group" aria-label="Roles">
						<div className="registry-rows-head" aria-hidden="true">
							<span>Key</span>
							<span>Name</span>
							<span />
						</div>
						{draft.roles.map((role, index) => (
							<div className="registry-row" key={index}>
								<FieldInput
									id={`external-app-role-${index}-key`}
									label={`Role ${index + 1} key`}
									value={role.key}
									problem={problems.get(`roles.${index}.key`)}
									placeholder="viewer"
									onChange={(key) => changeRole(index, { key })}
								/>
								<FieldInput
									id={`external-app-role-${index}-name`}
									label={`Role ${index + 1} name`}
									value={role.name}
									problem={problems.get(`roles.${index}.name`)}
									placeholder="Viewer"
									onChange={(name) => changeRole(index, { name })}
								/>
								<button
									type="button"
									className="ghost small"
									aria-label={`Remove role ${role.key === '' ? index + 1 : role.key}`}
									onClick={() => change({ roles: draft.roles.filter((_, at) => at !== index) })}
								>
									<Icon name="trash" size={13} />
								</button>
							</div>
						))}
					</div>
				)}
				<div>
					<button type="button" className="small" onClick={() => change({ roles: [...draft.roles, { key: '', name: '' }] })}>
						<Icon name="plus" size={13} />
						Add role
					</button>
				</div>
				{consequences.rolesIntroduced && (
					<p className="notice notice-bad" role="note">
						{creating
							? 'Nobody holds these roles yet, so everyone is refused until you grant one in Users.'
							: 'This application had no roles. Once saved, everyone is refused at their next sign-in or token refresh until you grant one of these roles in Users.'}
					</p>
				)}
				{consequences.removedRoles.length > 0 && (
					<p className="notice notice-bad" role="note">
						Removing {consequences.removedRoles.map((key) => `'${key}'`).join(', ')}{' '}
						takes it from everyone it is granted to. A person left with no role of this application is refused at their next sign-in or token refresh.
					</p>
				)}
				{consequences.rolesDropped && (
					<p className="notice notice-bad" role="note">
						Without roles, every active user of the installation can sign in to this application, external users included.
					</p>
				)}
			</fieldset>

			<fieldset className="registry-group">
				<legend>Clients</legend>
				<p className="hint">
					Each client publishes a Client ID Metadata Document at its client id. IAM sends people back only to the exact redirect URIs listed here.
				</p>
				{problems.has('clients') && <p className="error-text" role="alert">{problems.get('clients')}</p>}
				{draft.clients.map((client, index) => (
					<div className="registry-client" key={index} role="group" aria-label={`Client ${index + 1}`}>
						<div className="registry-client-head">
							<strong>Client {index + 1}</strong>
							<span className="spacer" />
							<button
								type="button"
								className="ghost small"
								onClick={() => change({ clients: draft.clients.filter((_, at) => at !== index) })}
							>
								<Icon name="trash" size={13} />
								Remove client
							</button>
						</div>
						<Field id={`external-app-client-${index}-id`} label="Client id" problem={problems.get(`clients.${index}.clientId`)}>
							{(state) => (
								<input
									{...state}
									id={`external-app-client-${index}-id`}
									value={client.clientId}
									onChange={(event) => changeClient(index, { clientId: event.currentTarget.value })}
									placeholder="https://tool.example.com/oauth/client.json"
									spellCheck={false}
								/>
							)}
						</Field>
						<Field
							id={`external-app-client-${index}-redirects`}
							label="Redirect URIs"
							problem={problems.get(`clients.${index}.redirectUris`)}
							hint="One per line, exactly as the client sends them."
						>
							{(state) => (
								<textarea
									{...state}
									id={`external-app-client-${index}-redirects`}
									rows={2}
									value={client.redirectUris}
									onChange={(event) => changeClient(index, { redirectUris: event.currentTarget.value })}
									placeholder="https://tool.example.com/oauth/callback"
									spellCheck={false}
								/>
							)}
						</Field>
						<Field
							id={`external-app-client-${index}-metadata`}
							label="Metadata URL (optional)"
							problem={problems.get(`clients.${index}.metadataUrl`)}
							hint="Only when the document is not served at the client id itself."
						>
							{(state) => (
								<input
									{...state}
									id={`external-app-client-${index}-metadata`}
									value={client.metadataUrl}
									onChange={(event) => changeClient(index, { metadataUrl: event.currentTarget.value })}
									spellCheck={false}
								/>
							)}
						</Field>
					</div>
				))}
				<div>
					<button type="button" className="small" onClick={() => change({ clients: [...draft.clients, emptyClient()] })}>
						<Icon name="plus" size={13} />
						Add client
					</button>
				</div>
				{consequences.removedClients.length > 0 && (
					<p className="notice notice-bad" role="note">
						Removing {consequences.removedClients.length === 1 ? 'a client' : `${consequences.removedClients.length} clients`} revokes{' '}
						{consequences.removedClients.length === 1 ? 'its' : 'their'} sign-ins. People signed in through{' '}
						{consequences.removedClients.length === 1 ? 'it' : 'them'} are signed out within five minutes.
					</p>
				)}
			</fieldset>

			{failure !== null && <p className="error-text" role="alert">{failure}</p>}
			<div className="form-actions">
				<button type="submit" className="primary" disabled={busy}>
					{busy ? 'Saving…' : creating ? 'Register application' : 'Save changes'}
				</button>
				<button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
			</div>
			{confirming !== null && (
				<ConfirmDialog
					title="Save and end sign-ins"
					confirmLabel="Save changes"
					body={
						<>
							<p>This save takes effect at once:</p>
							<ul>
								{confirming.lines.map((line) => <li key={line}>{line}</li>)}
							</ul>
						</>
					}
					onConfirm={() => save(confirming.request)}
					onClose={() => setConfirming(null)}
				/>
			)}
		</form>
	)
}

/** What a field's control carries so a screen reader announces its problem with it. */
interface FieldState {
	'aria-invalid': boolean
	'aria-describedby'?: string
}

function Field({ id, label, hint, problem, children }: {
	id: string
	label: string
	hint?: string
	problem: string | undefined
	children: (state: FieldState) => ReactNode
}) {
	const state: FieldState = problem === undefined ? { 'aria-invalid': false } : { 'aria-invalid': true, 'aria-describedby': `${id}-problem` }
	return (
		<label htmlFor={id} className={problem === undefined ? undefined : 'invalid'}>
			{label}
			{children(state)}
			{problem !== undefined && <span className="error-text" id={`${id}-problem`}>{problem}</span>}
			{hint !== undefined && <span className="hint">{hint}</span>}
		</label>
	)
}

/** A row cell's input: its label is for assistive technology, the column head shows it. */
function FieldInput({ id, label, value, problem, placeholder, onChange }: {
	id: string
	label: string
	value: string
	problem: string | undefined
	placeholder: string
	onChange: (value: string) => void
}) {
	return (
		<span className="registry-cell">
			<input
				id={id}
				aria-label={label}
				aria-invalid={problem !== undefined}
				aria-describedby={problem === undefined ? undefined : `${id}-problem`}
				value={value}
				placeholder={placeholder}
				spellCheck={false}
				onChange={(event) => onChange(event.currentTarget.value)}
			/>
			{problem !== undefined && <span className="error-text" id={`${id}-problem`}>{problem}</span>}
		</span>
	)
}
