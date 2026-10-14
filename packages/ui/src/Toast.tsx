import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { classNames } from './class-names'

export type ToastTone = 'neutral' | 'success' | 'danger'

export interface ToastOptions {
	readonly tone?: ToastTone
	readonly message: string
	/** How long the toast stays; `0` keeps it until it is dismissed. */
	readonly timeoutMs?: number
}

export interface ToastApi {
	readonly show: (options: ToastOptions) => void
}

interface ToastEntry {
	readonly id: number
	readonly tone: ToastTone
	readonly message: string
}

const ToastContext = createContext<ToastApi | undefined>(undefined)

export interface ToastProviderProps {
	readonly children: ReactNode
	readonly dismissLabel?: string
	readonly regionLabel?: string
}

export function ToastProvider({ children, dismissLabel = 'Dismiss', regionLabel = 'Notifications' }: ToastProviderProps) {
	const [toasts, setToasts] = useState<readonly ToastEntry[]>([])
	const nextId = useRef(1)
	const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

	const dismiss = useCallback((id: number) => {
		const timer = timers.current.get(id)
		if (timer !== undefined) clearTimeout(timer)
		timers.current.delete(id)
		setToasts((current) => current.filter((toast) => toast.id !== id))
	}, [])

	const show = useCallback(({ tone = 'neutral', message, timeoutMs = 5000 }: ToastOptions) => {
		const id = nextId.current++
		setToasts((current) => [...current, { id, tone, message }])
		if (timeoutMs > 0) timers.current.set(id, setTimeout(() => dismiss(id), timeoutMs))
	}, [dismiss])

	useEffect(() => {
		const pending = timers.current
		return () => {
			for (const timer of pending.values()) clearTimeout(timer)
			pending.clear()
		}
	}, [])

	const api = useMemo<ToastApi>(() => ({ show }), [show])

	return (
		<ToastContext.Provider value={api}>
			{children}
			<div className="fui-toast-region" role="status" aria-live="polite" aria-label={regionLabel}>
				{toasts.map((toast) => (
					<div key={toast.id} className={classNames('fui-toast', `fui-toast--${toast.tone}`)}>
						<span className="fui-toast__message">{toast.message}</span>
						<button type="button" className="fui-toast__dismiss" aria-label={dismissLabel} onClick={() => dismiss(toast.id)}>
							<span aria-hidden="true">×</span>
						</button>
					</div>
				))}
			</div>
		</ToastContext.Provider>
	)
}

export function useToast(): ToastApi {
	const api = useContext(ToastContext)
	if (api === undefined) throw new Error('useToast() must be called inside a <ToastProvider>; wrap the application root in one.')
	return api
}
