import type { AppScopeDef } from '@fabrika/iam-contract'

/**
 * The chosen scope for a grant / mapping. Two explicit states:
 *  - `{ kind: 'global' }`: all scopes → stored `scope_type = scope_value = null`
 *  - `{ kind: 'scoped', type, value }`: one flat dimension + an opaque app-owned value
 *
 * Scope dimensions come from the chosen app's reconciled schema (`app_scopes`). The
 * value is an OPAQUE app-owned string, never validated, never offered from a known list.
 */
export type ScopeValue =
	| { kind: 'global' }
	| { kind: 'scoped'; type: string; value: string }

/** Resolve a ScopeValue to the API `scopeType` / `scopeValue` pair (both null = global). */
export function resolveScope(value: ScopeValue): { scopeType: string | null; scopeValue: string | null } {
	if (value.kind === 'global') return { scopeType: null, scopeValue: null }
	const type = value.type.trim()
	const val = value.value.trim()
	if (type === '' || val === '') throw new Error('Pick a scope dimension and enter a value, or choose Global.')
	return { scopeType: type, scopeValue: val }
}

interface ScopePickerProps {
	/** Scope dimensions for the chosen app (from GET schema); empty when no app picked. */
	scopes: AppScopeDef[]
	value: ScopeValue
	onChange: (value: ScopeValue) => void
	idPrefix?: string
}

/**
 * Generic scope picker: Global, or one flat dimension (`type`, from the app's
 * `app_scopes`) plus an opaque text value. Defaults to Global. The value box is a free
 * text input: scope values are app-owned and never validated or enumerated here.
 */
export function ScopePicker({ scopes, value, onChange, idPrefix = 'scope' }: ScopePickerProps) {
	const scopedId = `${idPrefix}-scoped`
	const firstType = scopes[0]?.type ?? ''
	if (scopes.length === 0) return null
	const dimension = value.kind === 'scoped' ? scopes.find((scope) => scope.type === value.type) : undefined

	return (
		<div className="grant-scope">
			<label htmlFor={scopedId} className="checkbox">
				<input
					id={scopedId}
					type="checkbox"
					checked={value.kind === 'scoped'}
					onChange={(event) => onChange(event.target.checked ? { kind: 'scoped', type: firstType, value: '' } : { kind: 'global' })}
				/>
				Limit access to a specific scope
			</label>
			{value.kind === 'scoped' && (
				<div className="form-row">
					<label>
						Scope dimension
						<select
							value={value.type}
							onChange={(e) => onChange({ kind: 'scoped', type: e.target.value, value: '' })}
						>
							{scopes.map((s) => <option key={s.type} value={s.type}>{s.label ? `${s.label} (${s.type})` : s.type}</option>)}
						</select>
					</label>
					<label>
						Scope value
						<input
							value={value.value}
							onChange={(e) => onChange({ kind: 'scoped', type: value.type, value: e.target.value })}
							placeholder={`Enter ${dimension?.label ?? value.type} ID`}
						/>
					</label>
				</div>
			)}
			<p className="hint">
				{value.kind === 'global' ? 'Applies to all scopes within the selected application.' : 'Use the exact scope ID from the application.'}
			</p>
		</div>
	)
}
