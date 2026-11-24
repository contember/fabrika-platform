// Cron schedules away from the wall clock: a suite that declares a fixed time fails whenever a run straddles it,
// because whether a wake is due is the database's clock, which no fake clock moves.

const HOUR = 60 * 60_000

/** A daily cron fire `hoursAhead` from now, so its next fire lies just under that far ahead. */
export function dailyAhead(hoursAhead: number): string {
	const fire = new Date(Date.now() + hoursAhead * HOUR)
	return `${fire.getUTCMinutes()} ${fire.getUTCHours()} * * *`
}
