// The orders the person reaches: every one for the owner and accounting, their own customers' for a salesperson.
//
// The delete button shows for everyone on purpose. It is the demo's first scenario: accounting presses it, and the
// platform refuses the call before the application runs. A real screen would hide it with `<Can>`; that is only
// information for the page, never the check.

import { Can, useInfiniteQuery, useMutation } from '@fabrika/app/react'
import { Button, type Column, ConfirmDialog, DataTable, Inline, PageHeader, StatusPill } from '@fabrika/ui'
import { type ReactNode, useState } from 'react'
import { api, type Order } from '../api'
import { day, money, nextStatus, orderLabel, orderTone, overdue, today } from '../format'
import { describe, tableState, useReport } from './common'

interface Refusal {
	readonly number: string
	readonly message: string
}

export function Orders(): ReactNode {
	const orders = useInfiniteQuery(api.orders.list, {})
	const setStatus = useMutation(api.orders.setStatus)
	const remove = useMutation(api.orders.remove)
	const report = useReport()
	const [deleting, setDeleting] = useState<Order | null>(null)
	const [refusal, setRefusal] = useState<Refusal | null>(null)
	const now = today()

	const confirmDelete = async () => {
		if (deleting === null) return
		const order = deleting
		const outcome = await remove.mutate({ id: order.id, expectVersion: order.version })
		setDeleting(null)
		remove.reset()
		if (outcome.ok) {
			setRefusal(null)
			report(outcome, `Objednávka ${order.number} je smazaná`)
			return
		}
		setRefusal({
			number: order.number,
			message: outcome.error.kind === 'forbidden'
				? 'Mazat objednávky smí jen majitel. Tvoje role to nemá povolené, takže platforma požadavek odmítla dřív, než se dostal k datům. Objednávka zůstala beze změny.'
				: describe(outcome.error).message,
		})
	}

	const columns: readonly Column<Order>[] = [
		{ key: 'number', header: 'Číslo', cell: (order) => order.number },
		{ key: 'customer', header: 'Odběratel', cell: (order) => order.customerName },
		{ key: 'title', header: 'Položka', grow: true, wrap: true, cell: (order) => order.title },
		{
			key: 'due',
			header: 'Termín',
			cell: (order) =>
				overdue(order.dueOn, order.status, now)
					? <span className="orders-late">{day(order.dueOn)} · po termínu</span>
					: day(order.dueOn),
		},
		{ key: 'amount', header: 'Částka bez DPH', align: 'end', cell: (order) => money(order.amountCzk) },
		{ key: 'status', header: 'Stav', cell: (order) => <StatusPill tone={orderTone(order.status)}>{orderLabel(order.status)}</StatusPill> },
		{
			key: 'actions',
			header: <span className="orders-sr">Akce</span>,
			align: 'end',
			cell: (order) => {
				const next = nextStatus(order.status)
				return (
					<Inline gap={2}>
						{next === null ? null : (
							<Can action="orders.write">
								<Button
									size="sm"
									onClick={async () =>
										report(
											await setStatus.mutate({ id: order.id, expectVersion: order.version, status: next }),
											`${order.number}: ${orderLabel(next)}`,
										)}
								>
									{orderLabel(next)}
								</Button>
							</Can>
						)}
						<Button size="sm" variant="ghost" onClick={() => setDeleting(order)} aria-label={`Smazat ${order.number}`}>
							Smazat
						</Button>
					</Inline>
				)
			},
		},
	]

	return (
		<>
			<PageHeader title="Objednávky" lead="Objednávky od odběratelů, seřazené podle termínu." />
			{refusal === null ? null : (
				<div className="orders-refusal" role="alert">
					<strong>Objednávku {refusal.number} nejde smazat.</strong>
					<p>{refusal.message}</p>
					<Button size="sm" variant="ghost" onClick={() => setRefusal(null)}>Rozumím</Button>
				</div>
			)}
			<DataTable
				caption="Objednávky"
				columns={columns}
				rows={orders.items}
				rowKey={(order) => order.id}
				{...tableState(orders)}
				empty="Žádné objednávky."
			/>
			<ConfirmDialog
				open={deleting !== null}
				title="Smazat objednávku?"
				message={deleting === null ? '' : `Objednávka ${deleting.number} (${deleting.customerName}) se smaže i s podklady k fakturaci.`}
				confirmLabel="Smazat"
				cancelLabel="Nechat"
				tone="danger"
				pending={remove.pending}
				onConfirm={() => void confirmDelete()}
				onCancel={() => setDeleting(null)}
			/>
		</>
	)
}
