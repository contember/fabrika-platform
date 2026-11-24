// The guard every CLI's browser opener asks before it runs: under a test run only the test's own fake opener runs, so a
// test can never open the user's real browser, whatever platform it runs on and whichever opener names it forgot to
// fake.

import { isAbsolute, relative, resolve } from 'path'

/** The directory a test puts its fake opener in; under a test run no opener outside it runs. */
export const TEST_OPENER_DIR_VARIABLE = 'FABRIKA_TEST_OPENER_DIR'

/**
 * Whether a CLI may run the opener `which` resolved to `opener`. Outside a test run, always. Under one (`NODE_ENV=test`),
 * only an opener inside `FABRIKA_TEST_OPENER_DIR`; without that variable, none: the CLI prints the URL instead.
 * `bun test` sets `NODE_ENV=test` only when it is unset, so every test helper that spawns a CLI sets it explicitly.
 */
export function openerAllowed(opener: string, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
	if (env['NODE_ENV'] !== 'test') return true
	const directory = env[TEST_OPENER_DIR_VARIABLE]
	if (directory === undefined || directory === '') return false
	const inside = relative(resolve(directory), resolve(opener.trim()))
	return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
}
