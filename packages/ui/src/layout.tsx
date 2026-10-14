import type { ReactNode } from 'react'
import { classNames } from './class-names'

export type Gap = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export interface StackProps {
	readonly gap?: Gap
	readonly children: ReactNode
	readonly className?: string
}

export function Stack({ gap = 4, children, className }: StackProps) {
	return <div className={classNames('fui-stack', `fui-gap-${gap}`, className)}>{children}</div>
}

export interface InlineProps {
	readonly gap?: Gap
	readonly align?: 'start' | 'center' | 'end' | 'baseline' | 'stretch'
	readonly justify?: 'start' | 'center' | 'end' | 'between'
	readonly wrap?: boolean
	readonly children: ReactNode
	readonly className?: string
}

export function Inline({ gap = 2, align = 'center', justify = 'start', wrap = true, children, className }: InlineProps) {
	return (
		<div
			className={classNames(
				'fui-inline',
				`fui-gap-${gap}`,
				`fui-inline--align-${align}`,
				`fui-inline--justify-${justify}`,
				!wrap && 'fui-inline--nowrap',
				className,
			)}
		>
			{children}
		</div>
	)
}
