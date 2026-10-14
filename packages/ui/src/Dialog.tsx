import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useId, useRef } from 'react'
import { Button } from './Button'
import { classNames } from './class-names'

const FOCUSABLE = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled]):not([type="hidden"])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableIn(root: HTMLElement): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
}

export interface DialogProps {
	readonly open: boolean
	readonly title: ReactNode
	readonly description?: ReactNode
	readonly onClose: () => void
	readonly children?: ReactNode
	readonly actions?: ReactNode
	readonly closeLabel?: string
	readonly className?: string
}

/** A modal dialog rendered in place over a fixed overlay; it traps focus and gives it back on close. */
export function Dialog({ open, title, description, onClose, children, actions, closeLabel = 'Close', className }: DialogProps) {
	const dialogRef = useRef<HTMLDivElement>(null)
	const id = useId()
	const titleId = `${id}-title`
	const descriptionId = description === undefined ? undefined : `${id}-description`

	useEffect(() => {
		if (!open) return
		const opener = document.activeElement
		const dialog = dialogRef.current
		if (dialog) (focusableIn(dialog)[0] ?? dialog).focus()
		return () => {
			if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
		}
	}, [open])

	if (!open) return null

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === 'Escape') {
			event.stopPropagation()
			onClose()
			return
		}
		if (event.key !== 'Tab') return
		const dialog = event.currentTarget
		const focusable = focusableIn(dialog)
		const first = focusable[0]
		const last = focusable.at(-1)
		if (first === undefined || last === undefined) {
			event.preventDefault()
			dialog.focus()
			return
		}
		const active = document.activeElement
		if (event.shiftKey && (active === first || active === dialog)) {
			event.preventDefault()
			last.focus()
		} else if (!event.shiftKey && active === last) {
			event.preventDefault()
			first.focus()
		}
	}

	const handleOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
		if (event.target === event.currentTarget) onClose()
	}

	return (
		<div className="fui-dialog-overlay" onClick={handleOverlayClick}>
			<div
				ref={dialogRef}
				className={classNames('fui-dialog', className)}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={descriptionId}
				tabIndex={-1}
				onKeyDown={handleKeyDown}
			>
				<div className="fui-dialog__header">
					<h2 className="fui-dialog__title" id={titleId}>
						{title}
					</h2>
					<button type="button" className="fui-dialog__close" aria-label={closeLabel} onClick={onClose}>
						<span aria-hidden="true">×</span>
					</button>
				</div>
				{description !== undefined && (
					<p className="fui-dialog__description" id={descriptionId}>
						{description}
					</p>
				)}
				{children !== undefined && <div className="fui-dialog__body">{children}</div>}
				{actions !== undefined && <div className="fui-dialog__actions">{actions}</div>}
			</div>
		</div>
	)
}

export interface ConfirmDialogProps {
	readonly open: boolean
	readonly title: ReactNode
	readonly message: ReactNode
	readonly confirmLabel: string
	readonly cancelLabel?: string
	readonly tone?: 'primary' | 'danger'
	/** The confirmed work is running: the confirm button spins and the dialog cannot be dismissed. */
	readonly pending?: boolean
	readonly onConfirm: () => void
	readonly onCancel: () => void
	readonly closeLabel?: string
}

export function ConfirmDialog({
	open,
	title,
	message,
	confirmLabel,
	cancelLabel = 'Cancel',
	tone = 'primary',
	pending = false,
	onConfirm,
	onCancel,
	closeLabel,
}: ConfirmDialogProps) {
	const close = () => {
		if (!pending) onCancel()
	}
	return (
		<Dialog
			open={open}
			title={title}
			description={message}
			onClose={close}
			closeLabel={closeLabel}
			actions={
				<>
					<Button onClick={close} disabled={pending}>
						{cancelLabel}
					</Button>
					<Button variant={tone} loading={pending} onClick={onConfirm}>
						{confirmLabel}
					</Button>
				</>
			}
		/>
	)
}
