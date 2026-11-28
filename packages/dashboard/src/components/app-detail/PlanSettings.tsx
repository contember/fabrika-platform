import { type ApprovalSettings, PLAN_TTL_DAYS } from '@fabrika/control-contract'
import { useState } from 'react'
import { planBindingLabel } from '../../lib/approval-plans'
import type { PRESETS } from '../../lib/environment-protection'
import { PresetValue } from './PresetValue'

/**
 * The two plan settings, as their own group (ADR-0050 §5): what an approved plan binds to, and how many days it covers
 * a deploy. `daysText` is the field as typed; the settings change only once it is a whole number in bounds.
 */
export function PlanSettings(
	{ settings, daysText, daysValid, preset, locked, onSettings, onDays }: {
		settings: ApprovalSettings
		daysText: string
		daysValid: boolean
		preset: (typeof PRESETS)[number]
		locked: boolean
		onSettings: (settings: ApprovalSettings) => void
		onDays: (text: string) => void
	},
) {
	const bindingChanged = settings.planBinding !== preset.settings.planBinding
	const daysChanged = settings.planTtlDays !== preset.settings.planTtlDays
	const changed = [bindingChanged, daysChanged].filter(Boolean).length
	const [open] = useState(changed > 0)
	return (
		<details className="rule-group" open={open}>
			<summary>
				<span className="disclosure-title">Plans</span>
				<span className="muted">2 settings, {changed === 0 ? `all as ${preset.label}` : `${changed} changed from ${preset.label}`}</span>
			</summary>
			<div className="form">
				<div className={bindingChanged ? 'request-setting changed' : 'request-setting'}>
					<label>
						What an approved plan binds to
						<select
							value={settings.planBinding}
							disabled={locked}
							onChange={(event) => onSettings({ ...settings, planBinding: event.target.value === 'after-state' ? 'after-state' : 'transition' })}
						>
							<option value="transition">{planBindingLabel('transition')}</option>
							<option value="after-state">{planBindingLabel('after-state')}</option>
						</select>
						<span className="hint">
							The change from what runs: a plan covers a deploy only from the state its approver saw, or through plans approved one after another. The result
							alone: it covers a deploy that reaches the approved result from any state, with the lines its approver read.
						</span>
					</label>
					{bindingChanged && (
						<PresetValue
							preset={preset}
							text={planBindingLabel(preset.settings.planBinding)}
							label="What an approved plan binds to"
							locked={locked}
							onReset={() => onSettings({ ...settings, planBinding: preset.settings.planBinding })}
						/>
					)}
				</div>
				<div className={daysChanged ? 'request-setting changed' : 'request-setting'}>
					<label>
						Days an approved plan covers a deploy
						<input
							type="number"
							min={PLAN_TTL_DAYS.min}
							max={PLAN_TTL_DAYS.max}
							value={daysText}
							disabled={locked}
							aria-invalid={!daysValid}
							onChange={(event) => onDays(event.target.value)}
						/>
						<span className="hint">
							{`${PLAN_TTL_DAYS.min}–${PLAN_TTL_DAYS.max}, ${PLAN_TTL_DAYS.default} by default, counted from the approval; past it, a deploy waits for a person.`}
						</span>
						{!daysValid && <span className="error-text small">A whole number of days from {PLAN_TTL_DAYS.min} to {PLAN_TTL_DAYS.max}.</span>}
					</label>
					{daysChanged && (
						<PresetValue
							preset={preset}
							text={`${preset.settings.planTtlDays} d`}
							label="Days an approved plan covers a deploy"
							locked={locked}
							onReset={() => onDays(String(preset.settings.planTtlDays))}
						/>
					)}
				</div>
			</div>
		</details>
	)
}
