import type { AppScopeDef, DimensionValue, ScopeValuesUnavailable } from '@fabrika/iam-contract'
import { useEffect, useState } from 'react'
import { api } from './api'

/**
 * The values a dimension's application lists right now (ADR-0085 §4), asked through IAM as the signed-in administrator:
 *  - `static`: the dimension names no source, or no application is chosen; the declared `values` apply.
 *  - `loading`: IAM is asking the application.
 *  - `live`: the application's answer.
 *  - `unavailable`: IAM or the application could not answer; the declared `values`, else free text, apply.
 */
export type LiveScopeValues =
	| { status: 'static' }
	| { status: 'loading' }
	| { status: 'live'; values: DimensionValue[] }
	| { status: 'unavailable'; reason: ScopeValuesUnavailable | 'failed' }

/** Ask once per application and dimension; a later render of the same pair reuses the answer. */
export function useLiveScopeValues(app: string | null | undefined, dimension: Pick<AppScopeDef, 'type' | 'valueSource'>): LiveScopeValues {
	const asks = typeof app === 'string' && dimension.valueSource !== undefined
	const key = asks ? JSON.stringify([app, dimension.type]) : null
	const [answer, setAnswer] = useState<{ key: string; state: LiveScopeValues } | null>(null)

	useEffect(() => {
		if (key === null || typeof app !== 'string') return
		let cancelled = false
		api.scopeValues.list({ app, scopeType: dimension.type })
			.then((result) => {
				if (cancelled) return
				setAnswer({
					key,
					state: result.source === 'application' ? { status: 'live', values: result.values } : { status: 'unavailable', reason: result.reason },
				})
			})
			.catch(() => {
				if (!cancelled) setAnswer({ key, state: { status: 'unavailable', reason: 'failed' } })
			})
		return () => {
			cancelled = true
		}
	}, [key, app, dimension.type])

	if (key === null) return { status: 'static' }
	return answer?.key === key ? answer.state : { status: 'loading' }
}

/** Why the application's values are not shown, in the reader's words. */
export function unavailableReason(reason: ScopeValuesUnavailable | 'failed'): string {
	switch (reason) {
		case 'no_source':
			return 'the application declares no source of these values'
		case 'not_held':
			return 'you do not hold the permission the application asks for to list them'
		case 'no_origin':
			return 'the application has no registered address'
		case 'refused':
			return 'the application refused the request'
		case 'timeout':
			return 'the application did not answer in time'
		case 'unreachable':
			return 'the application could not be reached'
		case 'malformed':
			return 'the application answered something that is not a list of values'
		case 'failed':
			return 'the request failed'
	}
}
