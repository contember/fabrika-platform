/**
 * How the Operations error list is filtered.
 *
 * The filters are a `<form>`: `Search`, `Status`, `Source`, `Level`, `Window`, `Assignee` and `Sort`
 * only change local component state, and NOTHING is requested until the form is submitted. Typing a
 * query changes no rows, issues no request, and never touches the URL — the applied filters are
 * component state, not a query string, so a reload returns the list to its defaults.
 *
 * Three scenarios were written against the older list, which queried on every keystroke and every
 * `select`. They set values and asserted the narrowed result, so they went red the moment the submit
 * button appeared, and were re-authored around it
 * ([sprint](../../docs/archive/sprint-2026-08-05-auth-track-closeout.md)).
 * Set the controls, call this, then assert.
 */

import { byRole } from '@opice/harness'

export async function applyIssueFilters(): Promise<void> {
	await byRole('button', 'Apply', { exact: true }).click()
}
