import type { RoleDto } from '@fabrika/iam-contract'

interface RolePickerProps {
	roles: RoleDto[]
	value: string
	onChange: (roleKey: string) => void
	idPrefix: string
	emptyMessage?: string
}

export function RolePicker({ roles, value, onChange, idPrefix, emptyMessage = 'No roles are available for this application.' }: RolePickerProps) {
	const order: Record<RoleDto['origin'], number> = { app: 0, custom: 1, builtin: 2 }
	const sorted = [...roles].sort((a, b) => order[a.origin] - order[b.origin])

	return (
		<fieldset className="role-picker">
			<legend>Role</legend>
			{sorted.map((role) => (
				<label key={role.key}>
					<input
						type="radio"
						name={`${idPrefix}-role`}
						checked={value === role.key}
						onChange={() => onChange(role.key)}
					/>
					<span>
						<strong title={role.key}>{role.name}</strong>
						<span className="hint">{role.description ?? (role.permissions.join(', ') || 'This role has no permissions.')}</span>
					</span>
				</label>
			))}
			{roles.length === 0 && <p className="hint">{emptyMessage}</p>}
		</fieldset>
	)
}
