import type { AppDto } from '@fabrika/iam-contract'
import { useState } from 'react'
import { useAppVocab } from '../lib/useAppVocab'
import { ActionPicker } from './ActionPicker'
import { AppPicker, type AppValue, resolveApp } from './AppPicker'
import { RolePicker } from './RolePicker'
import { resolveScope, ScopePicker, type ScopeValue } from './ScopePicker'

/**
 * The authorization a grant / API-key / mapping confers, composed here:
 *  - `app`: the app the grant counts for (null = cross-app).
 *  - role XOR inline: exactly one of `roleKey` / `permissions` (enforced by the form).
 *  - scope: `scopeType` / `scopeValue` (both null = global).
 *
 * This is the subset of `CreateGrantRequest` / `ProvisionApiKeyRequest` the composer owns;
 * callers add `principalId` / `label` / `expiresAt` around it.
 */
export interface GrantAuthorization {
	app: string | null
	roleKey?: string
	permissions?: string[]
	scopeType: string | null
	scopeValue: string | null
}

/** 'role' = a named role/policy; 'inline' = an ad-hoc action set. Exactly one applies. */
type Mode = 'role' | 'inline'

interface GrantComposerProps {
	apps: AppDto[]
	/** Offer the cross-app option (an installation admin only). */
	crossApp?: boolean
	/** Called with a validated authorization, or throws an Error with a user message. */
	state: GrantComposerState
	idPrefix: string
	expiry: string
	onExpiryChange: (value: string) => void
	expiryHint?: string
}

/** Hoisted state so the parent form can read/reset it and run `build()` on submit. */
export interface GrantComposerState {
	appValue: AppValue
	setAppValue: (value: AppValue) => void
	mode: Mode
	setMode: (mode: Mode) => void
	roleKey: string
	setRoleKey: (key: string) => void
	permissions: string[]
	setPermissions: (permissions: string[]) => void
	scope: ScopeValue
	setScope: (scope: ScopeValue) => void
}

/** A fresh, empty composer state (defaults to role mode, unset app, global scope). */
export function useGrantComposerState(): GrantComposerState & { reset: () => void; build: () => GrantAuthorization } {
	const [appValue, storeAppValue] = useState<AppValue>({ kind: 'unset' })
	const [mode, setMode] = useState<Mode>('role')
	const [roleKey, setRoleKey] = useState('')
	const [permissions, setPermissions] = useState<string[]>([])
	const [scope, setScope] = useState<ScopeValue>({ kind: 'global' })

	function setAppValue(value: AppValue) {
		if (value.kind === appValue.kind && (value.kind !== 'app' || (appValue.kind === 'app' && value.app === appValue.app))) return
		storeAppValue(value)
		// Roles, actions and scope dimensions belong to the selected application.
		setMode('role')
		setRoleKey('')
		setPermissions([])
		setScope({ kind: 'global' })
	}

	function reset() {
		storeAppValue({ kind: 'unset' })
		setMode('role')
		setRoleKey('')
		setPermissions([])
		setScope({ kind: 'global' })
	}

	/** Validate and assemble the authorization, throwing an Error with a user-facing message. */
	function build(): GrantAuthorization {
		const app = resolveApp(appValue) // throws if app is still unset
		const { scopeType, scopeValue } = resolveScope(scope)
		if (mode === 'role') {
			if (roleKey === '') throw new Error('Pick a role.')
			return { app, roleKey, scopeType, scopeValue }
		}
		if (permissions.length === 0) throw new Error('Choose at least one permission.')
		return { app, permissions, scopeType, scopeValue }
	}

	return { appValue, setAppValue, mode, setMode, roleKey, setRoleKey, permissions, setPermissions, scope, setScope, reset, build }
}

/**
 * The shared grant body: pick an app, then EITHER a named role OR an inline action set,
 * plus a scope. The role list, scope dimensions and action catalog all derive from the
 * chosen app (loaded reactively via `useAppVocab`). The parent owns submit / expiry.
 */
export function GrantComposer({ apps, crossApp = true, state, idPrefix, expiry, onExpiryChange, expiryHint }: GrantComposerProps) {
	const { appValue, setAppValue, mode, setMode, roleKey, setRoleKey, permissions, setPermissions, scope, setScope } = state
	const app = appValue.kind === 'unset' ? undefined : appValue.kind === 'all' ? null : appValue.app
	const vocab = useAppVocab(app)
	const catalog = vocab.status === 'ok' ? vocab.vocab : null
	const selectedRole = catalog?.roles.find((role) => role.key === roleKey)
	const custom = mode === 'inline'
	const hasOptions = custom || scope.kind === 'scoped' || expiry !== ''

	return (
		<div className="grant-composer">
			<AppPicker apps={apps} value={appValue} onChange={setAppValue} idPrefix={`${idPrefix}-app`} crossApp={crossApp} />
			{custom
				? <p className="hint">Using the custom permissions set in advanced options.</p>
				: catalog && (
					<RolePicker
						roles={catalog.roles}
						value={roleKey}
						onChange={setRoleKey}
						idPrefix={idPrefix}
						emptyMessage={appValue.kind === 'unset' ? 'Choose an application to see its roles.' : undefined}
					/>
				)}
			{vocab.status === 'loading' && <p className="hint" role="status">Loading roles and permissions…</p>}
			{vocab.status === 'error' && (
				<div role="alert">
					<p className="error-text">{vocab.message}</p>
					<button type="button" className="small" onClick={vocab.retry}>Try again</button>
				</div>
			)}
			<details
				className="grant-options"
				onInvalidCapture={(event) => {
					// Reveal invalid controls synchronously so native validation can focus them.
					event.currentTarget.open = true
				}}
			>
				<summary>Advanced options{hasOptions && ' (configured)'}</summary>
				<div className="grant-options-body">
					{appValue.kind === 'app' && catalog && catalog.actions.length > 0 && (
						<label className="checkbox">
							<input type="checkbox" checked={custom} onChange={(event) => setMode(event.target.checked ? 'inline' : 'role')} />
							Choose individual permissions instead of a role
						</label>
					)}
					{custom && catalog && <ActionPicker actions={catalog.actions} value={permissions} onChange={setPermissions} idPrefix={`${idPrefix}-action`} />}
					{!custom && selectedRole && (
						<p className="hint">
							Role permissions: <code>{selectedRole.permissions.join(', ') || 'None'}</code>
						</p>
					)}
					<ScopePicker scopes={catalog?.scopes ?? []} value={scope} onChange={setScope} idPrefix={`${idPrefix}-scope`} />
					<label>
						Expires (optional)
						<input type="datetime-local" value={expiry} onChange={(event) => onExpiryChange(event.target.value)} />
						<span className="hint">{expiryHint ?? 'Leave empty for access that does not expire.'}</span>
					</label>
				</div>
			</details>
		</div>
	)
}
