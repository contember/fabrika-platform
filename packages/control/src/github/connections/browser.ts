import { GITHUB_SETUP_OUTCOME_PARAM, type GitHubSetupOutcome } from '@fabrika/control-contract'

/** The console page every GitHub browser route returns to. */
export const SOURCE_SETTINGS_PATH = '/settings/source'

export function consoleRedirect(outcome?: GitHubSetupOutcome): Response {
	return cleanRedirect(outcome === undefined ? SOURCE_SETTINGS_PATH : `${SOURCE_SETTINGS_PATH}?${GITHUB_SETUP_OUTCOME_PARAM}=${outcome}`)
}

export function cleanRedirect(location: string): Response {
	return new Response(null, {
		status: 303,
		headers: {
			'cache-control': 'no-store',
			location,
			'referrer-policy': 'no-referrer',
		},
	})
}
