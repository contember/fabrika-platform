import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { Button } from './Button'
import { classNames } from './class-names'
import { Checkbox } from './inputs'

export interface Column<Row> {
	readonly key: string
	readonly header: ReactNode
	readonly cell: (row: Row) => ReactNode
	readonly align?: 'start' | 'end'
	/** Takes the width the other columns leave; the remaining columns shrink to their content. */
	readonly grow?: boolean
	/** A width of the column scale (`--fui-column-width-<size>`), on its head and its cells. */
	readonly width?: ColumnWidth
	/** Its cells wrap their text instead of keeping it on one line. */
	readonly wrap?: boolean
}

export type ColumnWidth = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

export interface TableSelection {
	readonly selected: ReadonlySet<string>
	readonly onChange: (next: ReadonlySet<string>) => void
}

export interface LoadMore {
	readonly hasMore: boolean
	readonly loading: boolean
	readonly onLoadMore: () => void
	readonly label?: string
}

export type TableStatus = 'loading' | 'error' | 'ready'

export interface DataTableProps<Row> {
	readonly caption?: ReactNode
	readonly columns: readonly Column<Row>[]
	readonly rows: readonly Row[]
	readonly rowKey: (row: Row) => string
	readonly status?: TableStatus
	readonly error?: ReactNode
	readonly onRetry?: () => void
	readonly empty?: ReactNode
	readonly selection?: TableSelection
	readonly selectionActions?: (selectedKeys: readonly string[]) => ReactNode
	readonly loadMore?: LoadMore
	readonly selectRowLabel?: (row: Row) => string
	readonly selectAllLabel?: string
	readonly selectedLabel?: (count: number) => string
	readonly selectionToolbarLabel?: string
	readonly clearSelectionLabel?: string
	readonly loadingLabel?: string
	readonly retryLabel?: string
	readonly className?: string
}

const SKELETON_ROWS = 3

export function DataTable<Row>({
	caption,
	columns,
	rows,
	rowKey,
	status = 'ready',
	error,
	onRetry,
	empty = 'Nothing here yet',
	selection,
	selectionActions,
	loadMore,
	selectRowLabel = () => 'Select row',
	selectAllLabel = 'Select all rows',
	selectedLabel = (count) => `${count} selected`,
	selectionToolbarLabel = 'Selection',
	clearSelectionLabel = 'Clear selection',
	loadingLabel = 'Loading…',
	retryLabel = 'Retry',
	className,
}: DataTableProps<Row>) {
	const columnCount = columns.length + (selection ? 1 : 0)
	// A failed later page keeps the rows already loaded; the error row and its retry follow them.
	const showRows = status === 'ready' || (status === 'error' && rows.length > 0)
	const visibleKeys = showRows ? rows.map(rowKey) : []
	const selectedKeys = selection ? [...selection.selected] : []
	const selectedVisible = selection ? visibleKeys.filter((key) => selection.selected.has(key)).length : 0
	const allVisibleSelected = visibleKeys.length > 0 && selectedVisible === visibleKeys.length
	const someVisibleSelected = selectedVisible > 0 && !allVisibleSelected

	const setAllVisible = (checked: boolean) => {
		if (!selection) return
		const next = new Set(selection.selected)
		for (const key of visibleKeys) {
			if (checked) next.add(key)
			else next.delete(key)
		}
		selection.onChange(next)
	}

	const setRow = (key: string, checked: boolean) => {
		if (!selection) return
		const next = new Set(selection.selected)
		if (checked) next.add(key)
		else next.delete(key)
		selection.onChange(next)
	}

	const cellClassName = (column: Column<Row>) =>
		classNames(
			'fui-table__cell',
			column.align === 'end' && 'fui-table__cell--end',
			column.grow && 'fui-table__cell--grow',
			column.width !== undefined && `fui-table__cell--width-${column.width}`,
			column.wrap && 'fui-table__cell--wrap',
		)

	return (
		<div className={classNames('fui-data-table', className)}>
			{selection && selectedKeys.length > 0 && (
				<div className="fui-data-table__toolbar" role="toolbar" aria-label={selectionToolbarLabel}>
					<span className="fui-data-table__count">{selectedLabel(selectedKeys.length)}</span>
					<div className="fui-data-table__actions">{selectionActions?.(selectedKeys)}</div>
					<Button variant="ghost" size="sm" onClick={() => selection.onChange(new Set())}>
						{clearSelectionLabel}
					</Button>
				</div>
			)}
			<div className="fui-data-table__scroll">
				<table className="fui-table">
					{caption !== undefined && <caption className="fui-table__caption">{caption}</caption>}
					<thead>
						<tr>
							{selection && (
								<th className="fui-table__head fui-table__select" scope="col">
									<Checkbox
										label={selectAllLabel}
										hideLabel
										checked={allVisibleSelected}
										indeterminate={someVisibleSelected}
										disabled={visibleKeys.length === 0}
										onChange={setAllVisible}
									/>
								</th>
							)}
							{columns.map((column) => (
								<th key={column.key} scope="col" className={classNames('fui-table__head', cellClassName(column))}>
									{column.header}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{status === 'loading'
							&& Array.from({ length: SKELETON_ROWS }, (_, index) => (
								<tr key={index} className="fui-table__row fui-table__row--skeleton">
									{Array.from({ length: columnCount }, (_, cell) => (
										<td key={cell} className="fui-table__cell">
											{index === 0 && cell === 0 && (
												<span className="fui-visually-hidden" role="status">
													{loadingLabel}
												</span>
											)}
											<span className="fui-skeleton" aria-hidden="true" />
										</td>
									))}
								</tr>
							))}
						{status === 'ready' && rows.length === 0 && (
							<tr className="fui-table__row">
								<td className="fui-table__cell fui-table__message" colSpan={columnCount}>
									{empty}
								</td>
							</tr>
						)}
						{showRows && rows.map((row) => {
							const key = rowKey(row)
							const selected = selection?.selected.has(key) ?? false
							return (
								<tr key={key} className={classNames('fui-table__row', selected && 'fui-table__row--selected')}>
									{selection && (
										<td className="fui-table__cell fui-table__select">
											<Checkbox label={selectRowLabel(row)} hideLabel checked={selected} onChange={(checked) => setRow(key, checked)} />
										</td>
									)}
									{columns.map((column) => (
										<td key={column.key} className={cellClassName(column)}>
											{column.cell(row)}
										</td>
									))}
								</tr>
							)
						})}
						{status === 'error' && (
							<tr className="fui-table__row">
								<td className="fui-table__cell fui-table__message fui-table__message--error" colSpan={columnCount}>
									<span role="alert">{error}</span>
									{onRetry && (
										<Button size="sm" onClick={onRetry}>
											{retryLabel}
										</Button>
									)}
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
			{loadMore?.hasMore && (
				<div className="fui-data-table__more">
					<Button loading={loadMore.loading} onClick={loadMore.onLoadMore}>
						{loadMore.label ?? 'Load more'}
					</Button>
				</div>
			)}
		</div>
	)
}

export interface Selection extends TableSelection {
	readonly toggle: (key: string) => void
	readonly clear: () => void
}

/** Selection state shaped to pass straight to `DataTable`'s `selection`. */
export function useSelection(initial?: Iterable<string>): Selection {
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(initial))
	const toggle = useCallback((key: string) => {
		setSelected((current) => {
			const next = new Set(current)
			if (next.has(key)) next.delete(key)
			else next.add(key)
			return next
		})
	}, [])
	const clear = useCallback(() => setSelected(new Set()), [])
	return useMemo(() => ({ selected, onChange: setSelected, toggle, clear }), [selected, toggle, clear])
}
