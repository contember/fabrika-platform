// The five-field cron expressions of `c.cron`, read in UTC: which minutes a job is due, so the runner can tell how
// long ago it should last have succeeded. On Bun the crontab triggers a run; on Cloudflare the application's object
// runs, at each minute tick, the jobs `isDueAt` that minute.

interface Field {
	readonly min: number
	readonly max: number
}

const MINUTE: Field = { min: 0, max: 59 }
const HOUR: Field = { min: 0, max: 23 }
const DAY_OF_MONTH: Field = { min: 1, max: 31 }
const MONTH: Field = { min: 1, max: 12 }
// 7 is Sunday too, as in Vixie cron; it is folded into 0 below.
const DAY_OF_WEEK: Field = { min: 0, max: 7 }

const NUMBER = /^\d+$/
const MINUTE_MS = 60_000
/** How far back a due minute is looked for: a schedule that matches nothing in that window has no period. */
const SEARCH_DAYS = 366 * 5

export interface CronSchedule {
	readonly minutes: ReadonlySet<number>
	readonly hours: ReadonlySet<number>
	readonly daysOfMonth: ReadonlySet<number>
	readonly months: ReadonlySet<number>
	readonly daysOfWeek: ReadonlySet<number>
	/** Both day fields name days: a day is due when either matches (Vixie cron). */
	readonly eitherDay: boolean
}

function number(text: string, field: Field): number | null {
	if (!NUMBER.test(text)) {
		return null
	}
	const value = Number.parseInt(text, 10)
	return value >= field.min && value <= field.max ? value : null
}

/** `*`, `n`, `a-b`, each optionally `/step`, separated by commas; `null` for anything else. */
function parseField(text: string, field: Field): Set<number> | null {
	const values = new Set<number>()
	for (const item of text.split(',')) {
		const [range = '', step, extra] = item.split('/')
		if (extra !== undefined) {
			return null
		}
		const every = step === undefined ? 1 : number(step, { min: 1, max: field.max + 1 })
		if (every === null) {
			return null
		}
		let from: number | null = field.min
		let to: number | null = field.max
		if (range !== '*') {
			const [low = '', high, more] = range.split('-')
			if (more !== undefined) {
				return null
			}
			from = number(low, field)
			to = high === undefined ? (step === undefined ? from : field.max) : number(high, field)
		}
		if (from === null || to === null || from > to) {
			return null
		}
		for (let value = from; value <= to; value += every) {
			values.add(value)
		}
	}
	return values
}

/** The schedule of a five-field expression, or `null` when it is not one this runner reads. */
export function parseCron(expression: string): CronSchedule | null {
	const fields = expression.split(' ')
	if (fields.length !== 5) {
		return null
	}
	const [minute = '', hour = '', dayOfMonth = '', month = '', dayOfWeek = ''] = fields
	const minutes = parseField(minute, MINUTE)
	const hours = parseField(hour, HOUR)
	const daysOfMonth = parseField(dayOfMonth, DAY_OF_MONTH)
	const months = parseField(month, MONTH)
	const weekdays = parseField(dayOfWeek, DAY_OF_WEEK)
	if (minutes === null || hours === null || daysOfMonth === null || months === null || weekdays === null) {
		return null
	}
	const daysOfWeek = new Set([...weekdays].map((day) => day % 7))
	return { minutes, hours, daysOfMonth, months, daysOfWeek, eitherDay: !dayOfMonth.startsWith('*') && !dayOfWeek.startsWith('*') }
}

function dayMatches(schedule: CronSchedule, day: Date): boolean {
	if (!schedule.months.has(day.getUTCMonth() + 1)) {
		return false
	}
	const byMonth = schedule.daysOfMonth.has(day.getUTCDate())
	const byWeek = schedule.daysOfWeek.has(day.getUTCDay())
	return schedule.eitherDay ? byMonth || byWeek : byMonth && byWeek
}

/** Whether the schedule is due in the UTC minute that holds `at`: what a Worker's minute tick runs (ADR-0065). */
export function isDueAt(schedule: CronSchedule, at: Date): boolean {
	return schedule.minutes.has(at.getUTCMinutes()) && schedule.hours.has(at.getUTCHours()) && dayMatches(schedule, at)
}

const descending = (values: ReadonlySet<number>): number[] => [...values].sort((left, right) => right - left)

/** The latest `count` due minutes at or before `at`, newest first; fewer when the schedule is that rare. */
export function previousDue(schedule: CronSchedule, at: Date, count: number): Date[] {
	const due: Date[] = []
	const hours = descending(schedule.hours)
	const minutes = descending(schedule.minutes)
	const limit = Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS
	const today = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
	for (let back = 0; back <= SEARCH_DAYS && due.length < count; back++) {
		const day = new Date(today - back * 24 * 60 * MINUTE_MS)
		if (!dayMatches(schedule, day)) {
			continue
		}
		for (const hour of hours) {
			for (const minute of minutes) {
				const time = day.getTime() + (hour * 60 + minute) * MINUTE_MS
				if (time <= limit && due.length < count) {
					due.push(new Date(time))
				}
			}
		}
	}
	return due
}

/** The time between the two latest due minutes at or before `at`, or `null` when there are not two in the window. */
export function periodAt(schedule: CronSchedule, at: Date): number | null {
	const [latest, before] = previousDue(schedule, at, 2)
	return latest === undefined || before === undefined ? null : latest.getTime() - before.getTime()
}
