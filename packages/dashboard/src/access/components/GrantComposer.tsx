import type { AppDto, GrantDto } from '@fabrika/iam-contract'
import { useState } from 'react'
import { AppName } from '../lib/app-names'
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
	fixedApp?: boolean
	externalOnly?: boolean
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
export function useGrantComposerState(initial?: GrantDto): GrantComposerState & { reset: () => void; build: () => GrantAuthorization } {
	const [appValue, storeAppValue] = useState<AppValue>(
		initial === undefined ? { kind: 'unset' } : initial.app === null ? { kind: 'all' } : { kind: 'app', app: initial.app },
	)
	const [mode, setMode] = useState<Mode>(initial?.permissions ? 'inline' : 'role')
	const [roleKey, setRoleKey] = useState(initial?.roleKey ?? '')
	const [permissions, setPermissions] = useState<string[]>(initial?.permissions ?? [])
	const [scope, setScope] = useState<ScopeValue>(
		initial?.scopeType ? { kind: 'scoped', type: initial.scopeType, value: initial.scopeValue ?? '' } : { kind: 'global' },
	)

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
export function GrantComposer(
	{ apps, crossApp = true, state, idPrefix, expiry, onExpiryChange, expiryHint, fixedApp = false, externalOnly = false }: GrantComposerProps,
) {
	const { appValue, setAppValue, mode, setMode, roleKey, setRoleKey, permissions, setPermissions, scope, setScope } = state
	const app = appValue.kind === 'unset' ? undefined : appValue.kind === 'all' ? null : appValue.app
	const vocab = useAppVocab(app)
	const catalog = vocab.status === 'ok' ? vocab.vocab : null
	const roles = catalog?.roles.filter((role) => !externalOnly || role.external) ?? []
	const selectedRole = mode === 'role' ? roles.find((role) => role.key === roleKey) : undefined
	const memberScope = selectedRole?.member?.scope
	const custom = mode === 'inline'
	const hasOptions = custom || (scope.kind === 'scoped' && !memberScope) || expiry !== ''

	return (
		<div className="grant-composer">
			{fixedApp
				? (
					<p>
						Application: <strong>{app == null ? 'Platform services' : <AppName app={app} />}</strong>
					</p>
				)
				: <AppPicker apps={apps} value={appValue} onChange={setAppValue} idPrefix={`${idPrefix}-app`} crossApp={crossApp && !externalOnly} />}
			{externalOnly && <p className="hint">External people can hold only roles the application declares external.</p>}
			{custom
				? <p className="hint">Using the custom permissions set in advanced options.</p>
				: catalog && (
					<RolePicker
						roles={roles}
						value={roleKey}
						onChange={(key) => {
							setRoleKey(key)
							const dimension = roles.find((role) => role.key === key)?.member?.scope
							if (dimension && (scope.kind !== 'scoped' || scope.type !== dimension)) setScope({ kind: 'scoped', type: dimension, value: '' })
						}}
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
			{memberScope && (
				<label>
					{memberScope} value
					<input
						required
						value={scope.kind === 'scoped' ? scope.value : ''}
						onChange={(event) => setScope({ kind: 'scoped', type: memberScope, value: event.target.value })}
					/>
					<span className="hint">This membership role requires a specific {memberScope}.</span>
				</label>
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
					{!externalOnly && appValue.kind === 'app' && catalog && catalog.actions.length > 0 && (
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
					{!memberScope && <ScopePicker scopes={catalog?.scopes ?? []} value={scope} onChange={setScope} idPrefix={`${idPrefix}-scope`} />}
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
