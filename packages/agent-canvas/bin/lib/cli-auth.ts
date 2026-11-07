import { readFileSync } from 'fs'
import { CLI_AUTH_FILE } from './config.ts'

/** Must match `CLI_TOKEN_HEADER` and `CLI_TOKEN_QUERY` in daemon/src/admission.ts. */
const CLI_TOKEN_HEADER = 'X-Agent-Canvas-CLI-Token'
const CLI_TOKEN_QUERY = 'cli_token'

/**
 * The capability the running daemon wrote for its owner's CLI, or undefined when no daemon wrote one. Read on every
 * request: a restarted daemon writes a new one.
 */
export function readCliAuthToken(): string | undefined {
	try {
		const token = readFileSync(CLI_AUTH_FILE, 'utf-8').trim()
		return token === '' ? undefined : token
	} catch {
		return undefined
	}
}

/** Headers that authenticate a CLI request to the daemon; empty when no capability is available. */
export function cliAuthHeaders(): Record<string, string> {
	const token = readCliAuthToken()
	return token === undefined ? {} : { [CLI_TOKEN_HEADER]: token }
}

/** A daemon WebSocket URL that authenticates the CLI; the DOM `WebSocket` constructor the CLI is typed against takes no headers. */
export function cliSocketUrl(url: string): string {
	const token = readCliAuthToken()
	if (token === undefined) return url
	const authenticated = new URL(url)
	authenticated.searchParams.set(CLI_TOKEN_QUERY, token)
	return authenticated.toString()
}
