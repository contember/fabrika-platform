import { readCapabilityFile } from '@fabrika/daemon-kit'
import { BUILDER_CLI_TOKEN_HEADER, BUILDER_CLI_TOKEN_QUERY } from '../../shared/urls'
import { CLI_AUTH_FILE } from './config'

/** Headers that authenticate a CLI request to the daemon; empty when no daemon wrote a capability. */
export function cliAuthHeaders(): Record<string, string> {
	const token = readCapabilityFile(CLI_AUTH_FILE)
	return token === undefined ? {} : { [BUILDER_CLI_TOKEN_HEADER]: token }
}

/** A daemon WebSocket URL that authenticates the CLI; the DOM `WebSocket` constructor the CLI is typed against takes no headers. */
export function cliSocketUrl(url: string): string {
	const token = readCapabilityFile(CLI_AUTH_FILE)
	if (token === undefined) return url
	const authenticated = new URL(url)
	authenticated.searchParams.set(BUILDER_CLI_TOKEN_QUERY, token)
	return authenticated.toString()
}
