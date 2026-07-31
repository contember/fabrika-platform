import type { MeDto } from '@fabrika/iam-contract'
import { useEffect, useState } from 'react'
import { api, ApiError } from './api'

export type MeState =
	| { status: 'loading' }
	| { status: 'ok'; me: MeDto }
	| { status: 'forbidden' }
	| { status: 'error'; message: string }

/**
 * Fetch the current admin (`me`) once for the Access section. A 403 means the caller
 * is authenticated (a valid `px_session`) but is not an IAM admin — the nav-level gate. This
 * is UX only; IAM re-checks every admin call. A 401 is handled by the RPC client by
 * bouncing to the public IAM login URL supplied by the control-plane gateway.
 */
export function useMe(): MeState {
	const [state, setState] = useState<MeState>({ status: 'loading' })

	useEffect(() => {
		let cancelled = false
		api.me()
			.then((me) => {
				if (!cancelled) setState({ status: 'ok', me })
			})
			.catch((cause: unknown) => {
				if (cancelled) return
				if (cause instanceof ApiError && cause.httpStatus === 403) {
					setState({ status: 'forbidden' })
				} else {
					setState({
						status: 'error',
						message: cause instanceof ApiError ? cause.message : 'Failed to load.',
					})
				}
			})
		return () => {
			cancelled = true
		}
	}, [])

	return state
}
