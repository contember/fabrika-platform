import { useEffect, useRef, useState } from 'react'
import type { BuilderPlatformStatus } from '../../../shared'
import { type PlatformAction, platformClient, PlatformClientError } from './platformClient'

export function usePlatform(sessionId: string, live: boolean) {
	const [activeSession, setActiveSession] = useState(sessionId)
	const [data, setData] = useState<BuilderPlatformStatus | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [refresh, setRefresh] = useState(0)
	const mutation = useRef<AbortController | null>(null)
	useEffect(() => {
		setActiveSession(sessionId)
		setData(null)
		setError(null)
		setBusy(false)
		setRefresh(0)
		return () => {
			mutation.current?.abort()
			mutation.current = null
		}
	}, [sessionId])
	useEffect(() => {
		if (activeSession !== sessionId || !live || busy || error) return
		const controller = new AbortController()
		let timer: ReturnType<typeof setTimeout> | undefined
		let polls = 0
		const poll = async () => {
			try {
				if (++polls > 1200) throw new PlatformClientError('Automatic status refresh paused. Refresh status to continue.')
				const next = await platformClient.status(sessionId, controller.signal)
				if (controller.signal.aborted) return
				setData(next)
				setError(null)
				timer = setTimeout(poll, 3000)
			} catch (cause) {
				if (!controller.signal.aborted) {
					setError(cause instanceof PlatformClientError ? cause.message : 'Unable to read local deployment status.')
				}
			}
		}
		void poll()
		return () => {
			controller.abort()
			clearTimeout(timer)
		}
	}, [sessionId, activeSession, live, busy, refresh, error])
	const currentSession = activeSession === sessionId
	const enabled = currentSession && live && data !== null && error === null && !busy
	return {
		data: currentSession ? data : null,
		error: currentSession ? error : null,
		busy: currentSession && busy,
		enabled,
		refresh: () => {
			setData(null)
			setError(null)
			setRefresh((value) => value + 1)
		},
		act: async (action: PlatformAction) => {
			if (!enabled || mutation.current) return
			const controller = new AbortController()
			mutation.current = controller
			setBusy(true)
			try {
				const next = await platformClient.act(sessionId, action, controller.signal)
				if (!controller.signal.aborted) setData(next)
			} catch (cause) {
				if (!controller.signal.aborted) setError(cause instanceof PlatformClientError ? cause.message : 'Local operation failed. Refresh status.')
			} finally {
				if (mutation.current === controller) {
					mutation.current = null
					if (!controller.signal.aborted) setBusy(false)
				}
			}
		},
	}
}
