/**
 * Logging, constrained so that secret material cannot reach it.
 *
 * The rule is structural rather than aspirational: a log field is a `string | number | boolean |
 * null`, call sites pass only decision metadata, and the two values that CAN carry a credential —
 * a request path (share-link tokens ride in the path) and a URL — go through `redactPath` /
 * `redactUrl` first. Nothing in this package ever passes a header, a cookie, a token or a caught
 * error object to a logger.
 */

import { API_KEY_PREFIX } from '@fabrika/auth-core'

export type LogValue = string | number | boolean | null
export type LogFields = Record<string, LogValue>

export interface ProxyLogger {
	info(message: string, fields?: LogFields): void
	warn(message: string, fields?: LogFields): void
	error(message: string, fields?: LogFields): void
}

/** Emits one JSON object per line — what Zerops' log collector expects. */
export const consoleLogger: ProxyLogger = {
	info: (message, fields) => console.info(line('info', message, fields)),
	warn: (message, fields) => console.warn(line('warn', message, fields)),
	error: (message, fields) => console.error(line('error', message, fields)),
}

/** A logger that discards everything — the default, so a library consumer opts IN to output. */
export const silentLogger: ProxyLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
}

function line(level: string, message: string, fields: LogFields | undefined): string {
	return JSON.stringify({ level, message, ...fields })
}

/**
 * Make a path safe to log. Two hazards, both real:
 *   - a query string can carry a declared `query` credential (`?pxt=<token>`) — dropped entirely;
 *   - a path SEGMENT can be a share-link `px_` credential — replaced with `px_***`.
 * Anything else is preserved, because an unloggable path is an undebuggable proxy.
 */
export function redactPath(pathname: string): string {
	const query = pathname.indexOf('?')
	const path = query === -1 ? pathname : pathname.slice(0, query)
	return path
		.split('/')
		.map((segment) => (segment.startsWith(API_KEY_PREFIX) ? `${API_KEY_PREFIX}***` : segment))
		.join('/')
}

/** Origin + redacted path. Never the query string. */
export function redactUrl(url: URL): string {
	return `${url.origin}${redactPath(url.pathname)}`
}
