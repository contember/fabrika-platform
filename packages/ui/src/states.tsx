import type { ReactNode } from 'react'
import { Button } from './Button'
import { classNames } from './class-names'

export interface SpinnerProps {
	readonly label?: string
	readonly className?: string
}

export function Spinner({ label = 'Loading', className }: SpinnerProps) {
	return (
		<span className={classNames('fui-spinner', className)} role="status">
			<span className="fui-visually-hidden">{label}</span>
		</span>
	)
}

export interface CountBadgeProps {
	readonly count: number
	readonly className?: string
}

export function CountBadge({ count, className }: CountBadgeProps) {
	return <span className={classNames('fui-count-badge', className)}>{count}</span>
}

export interface EmptyStateProps {
	readonly title: ReactNode
	readonly text?: ReactNode
	readonly action?: ReactNode
	readonly className?: string
}

export function EmptyState({ title, text, action, className }: EmptyStateProps) {
	return (
		<div className={classNames('fui-state', 'fui-state--empty', className)}>
			<p className="fui-state__title">{title}</p>
			{text !== undefined && <p className="fui-state__text">{text}</p>}
			{action !== undefined && <div className="fui-state__action">{action}</div>}
		</div>
	)
}

export interface ErrorStateProps {
	readonly title?: ReactNode
	readonly text: ReactNode
	readonly onRetry?: () => void
	readonly retryLabel?: string
	readonly className?: string
}

export function ErrorState({ title = 'Something went wrong', text, onRetry, retryLabel = 'Retry', className }: ErrorStateProps) {
	return (
		<div className={classNames('fui-state', 'fui-state--error', className)} role="alert">
			<p className="fui-state__title">{title}</p>
			<p className="fui-state__text">{text}</p>
			{onRetry && (
				<div className="fui-state__action">
					<Button onClick={onRetry}>{retryLabel}</Button>
				</div>
			)}
		</div>
	)
}

export interface LoadingStateProps {
	readonly text?: ReactNode
	readonly className?: string
}

export function LoadingState({ text = 'Loading…', className }: LoadingStateProps) {
	return (
		<div className={classNames('fui-state', 'fui-state--loading', className)} role="status">
			<span className="fui-spinner" aria-hidden="true" />
			<p className="fui-state__text">{text}</p>
		</div>
	)
}
