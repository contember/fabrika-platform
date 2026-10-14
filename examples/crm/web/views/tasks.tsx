// Every task of the person's deals, by state, with the selected ones marked done or open again at once.

import { Can, useInfiniteQuery, useMutation } from '@fabrika/app/react'
import { Button, type Column, DataTable, PageHeader, StatusPill, Tabs, useSelection } from '@fabrika/ui'
import { type ReactNode, useState } from 'react'
import { api, type Task } from '../api'
import { day } from '../format'
import { Link } from '../routes'
import { tableState, useReport } from './common'

export type TaskTab = 'open' | 'overdue' | 'done'

/** The tab a task is listed under: done first, then overdue, else open. */
export function tabOf(task: Task): TaskTab {
	if (task.done) return 'done'
	return task.overdue ? 'overdue' : 'open'
}

export function Tasks(): ReactNode {
	const tasks = useInfiniteQuery(api.tasks.list, {}, { pages: 'all' })
	const complete = useMutation(api.tasks.complete)
	const report = useReport()
	const [tab, setTab] = useState<TaskTab>('open')
	const selection = useSelection()
	const count = (of: TaskTab) => tasks.items.filter((task) => tabOf(task) === of).length
	const shown = tasks.items.filter((task) => tabOf(task) === tab)
	const columns: readonly Column<Task>[] = [
		{ key: 'title', header: 'Task', grow: true, cell: (task) => <Link to="deal" params={{ id: task.dealId }}>{task.title}</Link> },
		{ key: 'due', header: 'Due', cell: (task) => day(task.dueOn) },
		{ key: 'assignee', header: 'Assignee', cell: (task) => task.assigneeLabel },
		{
			key: 'state',
			header: 'State',
			cell: (task) => (
				<StatusPill tone={task.done ? 'success' : task.overdue ? 'danger' : 'neutral'}>
					{task.done ? 'Done' : task.overdue ? 'Overdue' : 'Open'}
				</StatusPill>
			),
		},
	]
	const setDone = async (keys: readonly string[], done: boolean) => {
		const chosen = shown.filter((task) => keys.includes(task.id))
		let changed = 0
		for (const task of chosen) {
			const outcome = await complete.mutate({ id: task.id, done, expectVersion: task.version })
			if (!outcome.ok) {
				report(outcome, '')
				break
			}
			changed++
		}
		if (changed > 0) report({ ok: true, data: null }, `${changed} ${changed === 1 ? 'task' : 'tasks'} ${done ? 'done' : 'open again'}`)
		selection.clear()
	}
	return (
		<>
			<PageHeader title="Tasks" lead="Every task on the deals of your orgs, soonest first." />
			<Tabs
				label="Task state"
				items={[
					{ key: 'open', label: 'Open', count: count('open') },
					{ key: 'overdue', label: 'Overdue', count: count('overdue') },
					{ key: 'done', label: 'Done', count: count('done') },
				]}
				active={tab}
				onChange={(next) => {
					setTab(next)
					selection.clear()
				}}
			/>
			<DataTable
				caption="Tasks"
				columns={columns}
				rows={shown}
				rowKey={(task) => task.id}
				{...tableState(tasks)}
				empty={tab === 'done' ? 'No task is done yet.' : 'Nothing to do here.'}
				selection={selection}
				selectRowLabel={(task) => `Select ${task.title}`}
				selectionActions={(keys) => (
					<Can action="tasks.write">
						{tab === 'done'
							? <Button size="sm" loading={complete.pending} onClick={() => void setDone(keys, false)}>Mark open</Button>
							: <Button size="sm" variant="primary" loading={complete.pending} onClick={() => void setDone(keys, true)}>Mark done</Button>}
					</Can>
				)}
			/>
		</>
	)
}
