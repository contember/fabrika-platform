// What the request kinds of Control's local writes share (ADR-0083 §8): their coordinates, the environment generations
// a request binds, and how the outcome of a reused use case is read.

import { isAppEnvironmentPart } from '@fabrika/auth-core'
import { ALL_ENVIRONMENTS } from '@fabrika/control-contract'
import type { JsonValue } from '@fabrika/provider-contract'
import { z } from 'zod'
import { ControlApiError } from '../../../api/domain'
import type { RegistryUseCaseContext } from '../../../api/registry/context'
import type { RequestCoordinates, RequestExecution, RequestExecutionContext, RequestKindContext, RequestOutcome } from '../kind'

export const appIdField = z.string().min(1)

/** One environment by name; `*` names the all-environments layer, which a request asks for with `env: null`. */
export const envField = z.string().refine(
	(env) => isAppEnvironmentPart(env) && env !== ALL_ENVIRONMENTS,
	'env must be an environment name; the all-environments layer is env: null',
)

/** An environment, or the all-environments layer (`null`, or absent as the procedure takes it). */
export const layerField = envField.nullable().optional()

/** Where a write of one environment or of the all-environments layer acts. */
export function layerCoordinates(appId: string, env: string | null | undefined): RequestCoordinates {
	return { appId, env: env ?? ALL_ENVIRONMENTS }
}

/** How the page names where a write acts. */
export function layerName(appId: string, env: string | null): string {
	return env === null ? `every environment of ${appId}` : `${appId}@${env}`
}

/** What a registry write binds of the environments it reaches: each one's `generation`, by name. */
export const generationsField = z.record(z.number())

export async function generationsOf(c: RequestKindContext, appId: string, env: string | null): Promise<Record<string, number>> {
	const registry = c.repositories.registry
	const reach = env === null ? await registry.listAppEnvs(appId) : [await registry.getAppEnv(appId, env)]
	const generations: Record<string, number> = {}
	for (const appEnv of reach) {
		if (appEnv !== null) generations[appEnv.env] = appEnv.generation
	}
	return generations
}

/** The registry use cases' context for an execution: the approver, from the console, until the environment's lease is lost. */
export function registryContext(c: RequestExecutionContext, execution: RequestExecution): RegistryUseCaseContext {
	return {
		repositories: c.repositories,
		provider: c.provider,
		auth: c.auth,
		admission: c.admission,
		signal: execution.signal,
		reservedHosts: c.reservedHosts,
		...(c.catalogChanged === undefined ? {} : { catalogChanged: c.catalogChanged }),
		...(c.namespaceProxyChanged === undefined ? {} : { namespaceProxyChanged: c.namespaceProxyChanged }),
		...(c.grantApproval === undefined ? {} : { grantApproval: c.grantApproval }),
	}
}

/**
 * The outcome of a reused use case: what it answered, or its refusal (a 4xx it decides before it writes). Any other
 * throw leaves the outcome unknown, for the kind's `follow` to observe.
 */
export async function outcomeOf(run: () => Promise<JsonValue>): Promise<RequestOutcome> {
	try {
		return { state: 'executed', result: await run() }
	} catch (cause) {
		if (cause instanceof ControlApiError && cause.httpStatus < 500) return { state: 'failed', error: cause.message }
		throw cause
	}
}

/**
 * How `follow` settles a local write: a lease makes it atomic, so an execution that threw either wrote or did not, and
 * the state now says which.
 */
export function observed(applied: boolean, result: JsonValue): RequestOutcome {
	return applied
		? { state: 'executed', result }
		: { state: 'failed', error: 'the change is not in effect: it did not apply, or a later write replaced it; ask again if it is still needed' }
}

/** A value the agent wrote, for the page. */
export function agentText(text: string): { readonly text: string; readonly agent: true } {
	return { text, agent: true }
}

/** Fabrika's own words, for the page. */
export function ownText(text: string): { readonly text: string; readonly agent: false } {
	return { text, agent: false }
}

/** A time in Fabrika's own words: ISO 8601 for a reader that shows text as it is, and `at` for the page to format. */
export function timeText(seconds: number): { readonly text: string; readonly agent: false; readonly at: number } {
	return { text: new Date(seconds * 1000).toISOString(), agent: false, at: seconds }
}

/** A stored value as the page shows it: `none` when absent. */
export function shown(value: string | null): string {
	return value ?? 'none'
}
