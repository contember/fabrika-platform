import type { AuthContext } from '@fabrika/auth'
import type { exchangeGitHubAppManifestCode, GitHubAppFetch } from '@fabrika/github-app'
import { ACTIONS } from '../actions'
import type { Env } from '../env'
import { controlPublicOrigin } from '../iam'
import type { SourceConnectionPort } from '../source/connections'
import { SourceConnectionWorkflowError } from './errors'

export interface SourceConnectionWorkflowDeps {
	readonly env: Env
	readonly source: SourceConnectionPort
	readonly auth: AuthContext
	readonly request: Request
	readonly now?: () => number
	readonly randomBytes?: (length: number) => Uint8Array
	readonly exchangeManifest?: typeof exchangeGitHubAppManifestCode
	readonly githubFetch?: GitHubAppFetch
}

export function requireHuman(auth: AuthContext): string {
	if (!auth.can(ACTIONS.SOURCE_CONNECTION_MANAGE)) throw new SourceConnectionWorkflowError(403)
	if (auth.principal === null || auth.principal.type !== 'user') throw new SourceConnectionWorkflowError(403)
	return auth.principal.id
}

export function requireSameOrigin(env: Env, request: Request): string {
	const expected = requireControlOrigin(env)
	const origin = request.headers.get('origin')
	if (origin !== expected) throw new SourceConnectionWorkflowError(403)
	return expected
}

export function requireControlOrigin(env: Env): string {
	const expected = controlPublicOrigin(env)
	if (expected === undefined) throw new SourceConnectionWorkflowError(403)
	return expected
}

export async function audit(auth: AuthContext, action: string, resourceId: string): Promise<void> {
	await auth.audit({ action, resourceType: 'source_connection', resourceId })
}

export function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new DOMException('The source connection request was aborted', 'AbortError')
}

export function randomToken(length: number, source?: (length: number) => Uint8Array): string {
	const value = source?.(length) ?? crypto.getRandomValues(new Uint8Array(length))
	if (value.byteLength !== length) throw new SourceConnectionWorkflowError(500)
	let binary = ''
	for (const byte of value) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export async function sha256(value: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
	return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function serverDeadline(timeoutMs: number): { readonly signal: AbortSignal; dispose(): void } {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	return { signal: controller.signal, dispose: () => clearTimeout(timer) }
}

export function linkedDeadline(caller: AbortSignal, timeoutMs: number): { readonly signal: AbortSignal; dispose(): void } {
	const controller = new AbortController()
	const abort = (): void => controller.abort()
	if (caller.aborted) controller.abort()
	else caller.addEventListener('abort', abort, { once: true })
	const timer = setTimeout(abort, timeoutMs)
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer)
			caller.removeEventListener('abort', abort)
		},
	}
}

export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new DOMException('The source connection operation timed out', 'TimeoutError'))
	return new Promise((resolve, reject) => {
		const abort = (): void => reject(new DOMException('The source connection operation timed out', 'TimeoutError'))
		signal.addEventListener('abort', abort, { once: true })
		operation.then(
			(value) => {
				signal.removeEventListener('abort', abort)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort)
				reject(error)
			},
		)
	})
}
