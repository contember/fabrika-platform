import type { PRESETS } from '../../lib/environment-protection'

/** A setting that differs from the preset: what the preset says, and a way back to it. */
export function PresetValue({ preset, text, label, locked, onReset }: {
	preset: (typeof PRESETS)[number]
	text: string
	label: string
	locked: boolean
	onReset: () => void
}) {
	return (
		<div className="small">
			<span className="muted">
				{preset.label}: {text}
			</span>{' '}
			<button type="button" className="ghost small" disabled={locked} onClick={onReset}>
				Reset to {preset.label}
				<span className="sr-only">{`: ${label}`}</span>
			</button>
		</div>
	)
}
