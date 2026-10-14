import { type KeyboardEvent, useRef } from 'react'
import { classNames } from './class-names'
import { CountBadge } from './states'

export interface TabItem<K extends string> {
	readonly key: K
	readonly label: string
	readonly count?: number
}

export interface TabsProps<K extends string> {
	readonly label: string
	readonly items: readonly TabItem<K>[]
	readonly active: K
	readonly onChange: (key: K) => void
	readonly className?: string
}

function targetIndex(key: string, current: number, length: number): number | undefined {
	switch (key) {
		case 'ArrowRight':
			return (current + 1) % length
		case 'ArrowLeft':
			return (current - 1 + length) % length
		case 'Home':
			return 0
		case 'End':
			return length - 1
		default:
			return undefined
	}
}

/** A WAI-ARIA tab list with automatic activation: moving focus with the keyboard also selects. */
export function Tabs<K extends string>({ label, items, active, onChange, className }: TabsProps<K>) {
	const tabs = useRef(new Map<K, HTMLButtonElement>())
	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const current = items.findIndex((item) => tabs.current.get(item.key) === event.target)
		if (current === -1) return
		const next = targetIndex(event.key, current, items.length)
		const item = next === undefined ? undefined : items[next]
		if (item === undefined) return
		event.preventDefault()
		tabs.current.get(item.key)?.focus()
		if (item.key !== active) onChange(item.key)
	}
	return (
		<div className={classNames('fui-tabs', className)} role="tablist" aria-label={label} onKeyDown={handleKeyDown}>
			{items.map((item) => {
				const selected = item.key === active
				return (
					<button
						key={item.key}
						ref={(element) => {
							if (element) tabs.current.set(item.key, element)
							else tabs.current.delete(item.key)
						}}
						type="button"
						role="tab"
						aria-selected={selected}
						tabIndex={selected ? 0 : -1}
						className={classNames('fui-tabs__tab', selected && 'fui-tabs__tab--active')}
						onClick={() => {
							if (!selected) onChange(item.key)
						}}
					>
						{item.label}
						{item.count !== undefined && <CountBadge count={item.count} />}
					</button>
				)
			})}
		</div>
	)
}
