/**
 * How the Operations error list is filtered.
 *
 * The list has one search field, written GitHub-style: `status:resolved level:error <words>`, with `source:`,
 * `window:`, `assignee:` and `sort:` besides. Typing changes no rows and issues no request; Enter applies the field.
 * The field always shows exactly what is filtered, starting from `status:open window:24h`, and a qualifier left out
 * narrows nothing, so `fill` (which replaces the whole field) states every filter the step means. The applied filters
 * are component state, not a query string, so a reload returns the list to its defaults.
 *
 * Earlier the list had a `Search` box beside `Status`, `Source`, `Level`, `Window`, `Assignee` and `Sort` selects and
 * an `Apply` button; the scenarios that set those were re-authored around this one field.
 */

import { byLabel } from '@opice/harness'

/** Replaces the error list's search with `query` and applies it. */
export async function searchIssues(query: string): Promise<void> {
	const field = byLabel('Search')
	await field.fill(query)
	await field.press('Enter')
}
