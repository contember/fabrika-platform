/** Only a task in progress closes: an open one was never started, a done one is closed already. */
export const canClose = (status: 'open' | 'doing' | 'done'): boolean => status === 'doing'

/** A task is overdue on the day after its due day, until it is done. */
export const isOverdue = (status: 'open' | 'doing' | 'done', dueOn: string | null, today: string): boolean =>
	status !== 'done' && dueOn !== null && dueOn < today
