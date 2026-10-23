import type { AppDto } from '@fabrika/iam-contract'
import { appOptionLabel } from '../lib/app-names'

/** An explicit app choice: cross-app access is never the default. */
export type AppValue =
	| { kind: 'unset' }
	| { kind: 'all' }
	| { kind: 'app'; app: string }

export function resolveApp(value: AppValue): string | null {
	if (value.kind === 'all') return null
	if (value.kind === 'app') return value.app
	throw new Error('Pick an app first.')
}

interface AppPickerProps {
	apps: AppDto[]
	value: AppValue
	onChange: (value: AppValue) => void
	idPrefix?: string
	/** A user administrator never grants across applications (ADR-0058). */
	crossApp?: boolean
}

export function AppPicker({ apps, value, onChange, idPrefix = 'app', crossApp = true }: AppPickerProps) {
	return (
		<label htmlFor={idPrefix}>
			Application
			<select
				id={idPrefix}
				value={value.kind === 'app' ? `app:${value.app}` : value.kind === 'all' ? 'all' : ''}
				onChange={(event) => {
					const selected = event.target.value
					onChange(selected === '' ? { kind: 'unset' } : selected === 'all' ? { kind: 'all' } : { kind: 'app', app: selected.slice(4) })
				}}
			>
				<option value="">Choose an application…</option>
				{apps.map((app) => <option key={app.id} value={`app:${app.id}`}>{appOptionLabel(app)}</option>)}
				{crossApp && <option value="all">Platform services (cross-app)</option>}
			</select>
			{apps.length === 0 && !crossApp && <span className="hint">You do not administer any applications.</span>}
		</label>
	)
}
