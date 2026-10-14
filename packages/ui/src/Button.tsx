import type { ComponentProps } from 'react'
import { classNames } from './class-names'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

function buttonClassName(variant: ButtonVariant, size: ButtonSize, className: string | undefined): string {
	return classNames('fui-button', `fui-button--${variant}`, size === 'sm' && 'fui-button--sm', className)
}

export interface ButtonProps extends Readonly<ComponentProps<'button'>> {
	readonly variant?: ButtonVariant
	readonly size?: ButtonSize
	/** Disables the button and shows a spinner beside its label until the work it started settles. */
	readonly loading?: boolean
}

export function Button(
	{ variant = 'secondary', size = 'md', loading = false, type = 'button', disabled, className, children, ...rest }: ButtonProps,
) {
	return (
		<button
			{...rest}
			type={type}
			disabled={disabled || loading}
			aria-busy={loading || undefined}
			className={buttonClassName(variant, size, classNames(loading && 'fui-button--loading', className))}
		>
			{loading && <span className="fui-spinner fui-spinner--inline" aria-hidden="true" />}
			{children}
		</button>
	)
}

export interface ButtonLinkProps extends Readonly<ComponentProps<'a'>> {
	readonly href: string
	readonly variant?: ButtonVariant
	readonly size?: ButtonSize
}

export function ButtonLink({ variant = 'secondary', size = 'md', className, children, ...rest }: ButtonLinkProps) {
	return (
		<a {...rest} className={buttonClassName(variant, size, className)}>
			{children}
		</a>
	)
}
