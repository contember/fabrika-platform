// What the views show, as pure functions of the answers: labels, tones, money, dates and the form fields' values.

import { DEAL_STAGES } from '../src/schemas'

export type Stage = (typeof DEAL_STAGES)[number]
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent'

const STAGE_LABELS: Readonly<Record<Stage, string>> = { lead: 'Lead', qualified: 'Qualified', proposal: 'Proposal', won: 'Won', lost: 'Lost' }
const STAGE_TONES: Readonly<Record<Stage, Tone>> = { lead: 'neutral', qualified: 'info', proposal: 'accent', won: 'success', lost: 'danger' }

export const stageLabel = (stage: Stage): string => STAGE_LABELS[stage]
export const stageTone = (stage: Stage): Tone => STAGE_TONES[stage]
export const isClosed = (stage: Stage): boolean => stage === 'won' || stage === 'lost'

/** The stage a deal moves on to, or `null` for a closed deal and the last open stage's successor. */
export function nextStage(stage: Stage): Stage | null {
	if (isClosed(stage)) return null
	const next = DEAL_STAGES[DEAL_STAGES.indexOf(stage) + 1]
	return next === undefined || next === 'lost' ? null : next
}

export function stageOf(value: string): Stage | null {
	return DEAL_STAGES.find((stage) => stage === value) ?? null
}

const EUR = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })

export const money = (value: number): string => EUR.format(value)

/** `2026-10-14T09:30:00.000Z` as `14 Oct 2026, 09:30` (UTC: the API answers UTC). */
export function dateTime(iso: string): string {
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return iso
	return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date)
}

/** A `YYYY-MM-DD` day as `14 Oct 2026`. */
export function day(isoDate: string): string {
	const date = new Date(`${isoDate}T00:00:00Z`)
	if (Number.isNaN(date.getTime())) return isoDate
	return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(date)
}

/** A text field's value, trimmed; `''` for a missing one. */
export function text(form: FormData, name: string): string {
	const value = form.get(name)
	return typeof value === 'string' ? value.trim() : ''
}

/** An edit form's clearable field: an empty one clears the column. */
export const orNull = (value: string): string | null => (value === '' ? null : value)

/** A create form's optional field: an empty one is left out of the input. */
export const orOmitted = (value: string): string | undefined => (value === '' ? undefined : value)

/** A whole number the field holds, or `NaN` for anything else, which the input schema then refuses with its message. */
export function wholeNumber(value: string): number {
	return /^-?\d+$/.test(value) ? Number(value) : Number.NaN
}
