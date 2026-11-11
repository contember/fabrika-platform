// What the screens show, as pure functions of the answers: labels, tones, money and days.

import type { BILLING_STATUSES, ORDER_STATUSES } from '../src/schemas'

export type OrderStatus = (typeof ORDER_STATUSES)[number]
export type BillingStatus = (typeof BILLING_STATUSES)[number]
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent'

const ORDER_LABELS: Readonly<Record<OrderStatus, string>> = {
	nova: 'Nová',
	potvrzena: 'Potvrzená',
	expedovana: 'Expedovaná',
	dorucena: 'Doručená',
	zrusena: 'Zrušená',
}
const ORDER_TONES: Readonly<Record<OrderStatus, Tone>> = {
	nova: 'info',
	potvrzena: 'accent',
	expedovana: 'warning',
	dorucena: 'success',
	zrusena: 'neutral',
}
const NEXT: Readonly<Record<OrderStatus, OrderStatus | null>> = {
	nova: 'potvrzena',
	potvrzena: 'expedovana',
	expedovana: 'dorucena',
	dorucena: null,
	zrusena: null,
}

export const orderLabel = (status: OrderStatus): string => ORDER_LABELS[status]
export const orderTone = (status: OrderStatus): Tone => ORDER_TONES[status]
export const nextStatus = (status: OrderStatus): OrderStatus | null => NEXT[status]

export const billingLabel = (status: BillingStatus): string => (status === 'vyfakturovano' ? 'Vyfakturováno' : 'Připraveno')
export const billingTone = (status: BillingStatus): Tone => (status === 'vyfakturovano' ? 'success' : 'warning')

const CZK = new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 })
export const money = (value: number): string => CZK.format(value)

/** A `YYYY-MM-DD` day as `14. 11. 2026`. */
export function day(isoDate: string): string {
	const date = new Date(`${isoDate}T00:00:00Z`)
	if (Number.isNaN(date.getTime())) return isoDate
	return new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeZone: 'UTC' }).format(date)
}

/** Whether an open order's day has passed, by the browser's calendar day. */
export function overdue(isoDate: string, status: OrderStatus, today: string): boolean {
	return (status === 'nova' || status === 'potvrzena') && isoDate < today
}

/** Today as `YYYY-MM-DD` in the browser's time zone. */
export function today(): string {
	const now = new Date()
	const month = String(now.getMonth() + 1).padStart(2, '0')
	const date = String(now.getDate()).padStart(2, '0')
	return `${now.getFullYear()}-${month}-${date}`
}
