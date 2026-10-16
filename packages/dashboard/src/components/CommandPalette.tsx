import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { rankCommands, type Searchable } from '../lib/command-search'
import { Icon, type IconName } from './Icon'

export interface Command extends Searchable {
	id: string
	/** The kind it lists under: Pages, Actions, Applications… */
	group: string
	icon: IconName
	/** A quiet line after the title: the page's section, a person's email. */
	detail?: string
	run: () => void
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

/** The shortcut as this keyboard writes it. */
export function shortcutLabel(): string {
	return isMac() ? '⌘K' : 'Ctrl K'
}

/**
 * Opens on ⌘K (Ctrl K off a Mac) from anywhere in the console, and closes on the same keys or Escape. On a Mac, Ctrl K
 * stays the text fields' delete-to-end-of-line. While a modal is up the shortcut does nothing: a blocking one (a key
 * shown once) must not be left by navigating away, and two layers of dialog would close together on Escape.
 */
export function usePaletteShortcut(enabled: boolean, setOpen: (update: (open: boolean) => boolean) => void) {
	useEffect(() => {
		if (!enabled) return
		const mac = isMac()
		function onKey(event: KeyboardEvent) {
			if (event.defaultPrevented || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return
			if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return
			if (document.querySelector('.modal-backdrop:not(.palette-backdrop)') !== null) return
			event.preventDefault()
			setOpen((open) => !open)
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [enabled, setOpen])
}

/** How long a typed query rests before the palette asks a service to search for it. */
const SEARCH_DELAY_MS = 200

/**
 * The console's spotlight: one field that finds a page, an action or one of the installation's objects and opens it.
 * Typing ranks the commands it was given (`lib/command-search`); `search` adds what a service finds for the query (the
 * people, whom IAM searches past its first page). The arrows move, Enter opens, Escape closes. The list is a listbox
 * the field controls, so the focus never leaves the field, and Tab stays in it. The highlight follows the command, not
 * its row, so a list that grows while loading never moves it onto something else.
 */
export function CommandPalette(
	{ commands, loading, search, onClose }: {
		commands: readonly Command[]
		loading: boolean
		search?: (query: string) => Promise<Command[]>
		onClose: () => void
	},
) {
	const [query, setQuery] = useState('')
	const [activeId, setActiveId] = useState<string | null>(null)
	const [searched, setSearched] = useState<{ query: string; commands: Command[] }>({ query: '', commands: [] })
	const field = useRef<HTMLInputElement>(null)
	const list = useRef<HTMLDivElement>(null)
	const id = useId()

	useEffect(() => {
		const typed = query.trim()
		if (search === undefined || typed === '') return
		let stale = false
		const timer = window.setTimeout(() => {
			void search(typed).then((found) => {
				if (!stale) setSearched({ query: typed, commands: found })
			})
		}, SEARCH_DELAY_MS)
		return () => {
			stale = true
			window.clearTimeout(timer)
		}
	}, [query, search])

	// With nothing typed the palette offers the pages and actions; the objects are what a query reaches. Each kind stays
	// together under its heading, the kinds in the order of their best match. A service's answer joins only while it
	// still answers what is typed.
	const found = useMemo(() => {
		const typed = query.trim()
		const offered = typed === '' ? commands.filter((command) => command.group === 'Pages' || command.group === 'Actions') : commands
		const ranked = [...rankCommands(offered, query), ...(searched.query === typed && typed !== '' ? searched.commands : [])]
		const groups = [...new Set(ranked.map((command) => command.group))]
		return groups.flatMap((group) => ranked.filter((command) => command.group === group))
	}, [commands, query, searched])
	const currentIndex = Math.max(0, found.findIndex((command) => command.id === activeId))
	const current = found[currentIndex]

	// Back to where the person was when it closes, as a dialog should.
	useEffect(() => {
		const before = document.activeElement
		field.current?.focus()
		return () => {
			if (before instanceof HTMLElement) before.focus()
		}
	}, [])

	useEffect(() => {
		list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
	}, [current])

	function open(command: Command | undefined) {
		if (command === undefined) return
		onClose()
		command.run()
	}

	function move(by: number) {
		if (found.length === 0) return
		setActiveId(found[(currentIndex + by + found.length) % found.length]?.id ?? null)
	}

	function onKey(event: React.KeyboardEvent) {
		if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
			event.preventDefault()
			move(1)
		} else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
			event.preventDefault()
			move(-1)
		} else if (event.key === 'Enter') {
			event.preventDefault()
			open(current)
		} else if (event.key === 'Escape') {
			// Only the palette closes, not a dialog under it listening on `window`.
			event.preventDefault()
			event.stopPropagation()
			onClose()
		} else if (event.key === 'Tab') {
			// The field is the dialog's only control, so Tab has nowhere inside to go and must not reach the page under it.
			event.preventDefault()
		}
	}

	return (
		<div className="modal-backdrop palette-backdrop" role="presentation" onMouseDown={onClose}>
			<div className="palette" role="dialog" aria-modal="true" aria-label="Go to" onMouseDown={(event) => event.stopPropagation()}>
				<div className="palette-field">
					<Icon name="search" size={16} />
					<input
						ref={field}
						type="text"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value)
							setActiveId(null)
						}}
						onKeyDown={onKey}
						placeholder="Go to a page, an application, a person…"
						role="combobox"
						aria-label="Go to"
						aria-expanded="true"
						aria-controls={`${id}-list`}
						aria-activedescendant={current === undefined ? undefined : `${id}-${current.id}`}
						aria-autocomplete="list"
						spellCheck={false}
						autoComplete="off"
					/>
					<kbd>esc</kbd>
				</div>
				<div ref={list} id={`${id}-list`} className="palette-list" role="listbox" aria-label="Results">
					{found.length === 0 && <p className="palette-empty">{loading ? 'Looking…' : 'Nothing matches.'}</p>}
					{found.map((command, index) => (
						<div key={command.id}>
							{(index === 0 || found[index - 1]?.group !== command.group) && <div className="palette-group" aria-hidden="true">{command.group}</div>}
							<div
								id={`${id}-${command.id}`}
								className="palette-option"
								role="option"
								aria-selected={command === current}
								onMouseMove={() => setActiveId(command.id)}
								onClick={() => open(command)}
							>
								<Icon name={command.icon} size={16} />
								<span className="palette-title">{command.title}</span>
								{command.detail !== undefined && <span className="palette-detail">{command.detail}</span>}
								{command === current && (
									<span className="palette-go">
										<Icon name="arrow-right" size={14} />
									</span>
								)}
							</div>
						</div>
					))}
				</div>
				<div className="palette-foot" aria-hidden="true">
					<span>
						<kbd>↑</kbd>
						<kbd>↓</kbd> move
					</span>
					<span>
						<kbd>↵</kbd> open
					</span>
					{loading && found.length > 0 && <span className="palette-loading">Loading applications and sources…</span>}
				</div>
			</div>
		</div>
	)
}
