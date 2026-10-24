import type { ReactNode } from 'react'

export function Reading({ label, value, note }: { label: string; value: ReactNode; note: ReactNode }) {
	return (
		<>
			<div className="instrument-label">{label}</div>
			<div className="instrument-value">{value}</div>
			<div className="instrument-note">{note}</div>
		</>
	)
}
