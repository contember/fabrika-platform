// The invoicing records: accounting prepares one for a delivered order and marks it billed with the invoice number.

import { useInfiniteQuery, useMutation, useQuery } from '@fabrika/app/react'
import { Button, type Column, DataTable, Dialog, Field, Form, FormActions, Input, PageHeader, StatusPill } from '@fabrika/ui'
import { type ReactNode, useState } from 'react'
import { api, type BillingRecord, type Order } from '../api'
import { billingLabel, billingTone, day, money } from '../format'
import { describe, useReport } from './common'

function MarkInvoiced({ record, onClose }: { readonly record: BillingRecord | null; readonly onClose: () => void }) {
	const mark = useMutation(api.billing.markInvoiced)
	const report = useReport()
	const close = () => {
		mark.reset()
		onClose()
	}
	const submit = async (form: FormData) => {
		if (record === null) return
		const value = form.get('invoiceNumber')
		const outcome = await mark.mutate({
			orderId: record.orderId,
			id: record.id,
			expectVersion: record.version,
			invoiceNumber: typeof value === 'string' ? value.trim() : '',
		})
		if (!outcome.ok) return
		report(outcome, 'Označeno jako vyfakturované')
		close()
	}
	return (
		<Dialog open={record !== null} title="Vyfakturováno" onClose={close}>
			<Form onSubmit={(form) => void submit(form)} error={mark.error === null ? null : describe(mark.error)} aria-label="Vyfakturováno">
				<Field label="Číslo faktury" name="invoiceNumber" required>
					<Input name="invoiceNumber" autoComplete="off" placeholder="FV-2026-0188" />
				</Field>
				<FormActions>
					<Button variant="ghost" onClick={close}>Zpět</Button>
					<Button type="submit" variant="primary" loading={mark.pending}>Uložit</Button>
				</FormActions>
			</Form>
		</Dialog>
	)
}

export function Billing(): ReactNode {
	const records = useQuery(api.billing.list)
	const orders = useInfiniteQuery(api.orders.list, {}, { pages: 'all' })
	const prepare = useMutation(api.billing.prepare)
	const report = useReport()
	const [marking, setMarking] = useState<BillingRecord | null>(null)
	const orderOf = (id: string): Order | undefined => orders.items.find((order) => order.id === id)
	const billed = new Set(records.status === 'success' ? records.data.items.map((record) => record.orderId) : [])
	const waiting = orders.items.filter((order) => (order.status === 'dorucena' || order.status === 'expedovana') && !billed.has(order.id))

	const columns: readonly Column<BillingRecord>[] = [
		{ key: 'order', header: 'Objednávka', cell: (record) => orderOf(record.orderId)?.number ?? '…' },
		{ key: 'customer', header: 'Odběratel', grow: true, cell: (record) => orderOf(record.orderId)?.customerName ?? '…' },
		{ key: 'base', header: 'Základ', align: 'end', cell: (record) => money(record.amountCzk) },
		{ key: 'vat', header: 'DPH', align: 'end', cell: (record) => `${record.vatRate} %` },
		{ key: 'total', header: 'Celkem', align: 'end', cell: (record) => money(record.totalCzk) },
		{ key: 'status', header: 'Stav', cell: (record) => <StatusPill tone={billingTone(record.status)}>{billingLabel(record.status)}</StatusPill> },
		{ key: 'invoice', header: 'Faktura', cell: (record) => record.invoiceNumber ?? '' },
		{
			key: 'actions',
			header: <span className="orders-sr">Akce</span>,
			align: 'end',
			cell: (record) => record.status === 'pripraveno' ? <Button size="sm" onClick={() => setMarking(record)}>Vyfakturováno</Button> : null,
		},
	]
	const waitingColumns: readonly Column<Order>[] = [
		{ key: 'number', header: 'Objednávka', cell: (order) => order.number },
		{ key: 'customer', header: 'Odběratel', grow: true, cell: (order) => order.customerName },
		{ key: 'due', header: 'Termín', cell: (order) => day(order.dueOn) },
		{ key: 'amount', header: 'Základ', align: 'end', cell: (order) => money(order.amountCzk) },
		{
			key: 'actions',
			header: <span className="orders-sr">Akce</span>,
			align: 'end',
			cell: (order) => (
				<Button
					size="sm"
					onClick={async () => {
						report(await prepare.mutate({ orderId: order.id, vatRate: 12 }), `Podklad k ${order.number} je připravený`)
						void records.refetch()
					}}
				>
					Připravit podklad
				</Button>
			),
		},
	]

	return (
		<>
			<PageHeader title="Fakturace" lead="Podklady k fakturaci podle objednávek. Odběratele samotné účtárna nevidí." />
			<DataTable
				caption="Podklady k fakturaci"
				columns={columns}
				rows={records.status === 'success' ? records.data.items : []}
				rowKey={(record) => record.id}
				status={records.status === 'success' ? 'ready' : records.status === 'error' ? 'error' : 'loading'}
				{...(records.status === 'error' ? { error: describe(records.error).message } : {})}
				onRetry={() => void records.refetch()}
				empty="Žádné podklady."
			/>
			<h2 className="orders-subheading">Čeká na podklad</h2>
			<DataTable
				caption="Objednávky bez podkladu"
				columns={waitingColumns}
				rows={waiting}
				rowKey={(order) => order.id}
				status={orders.status === 'success' ? 'ready' : orders.status === 'error' ? 'error' : 'loading'}
				empty="Všechno expedované má podklad."
			/>
			<MarkInvoiced record={marking} onClose={() => setMarking(null)} />
		</>
	)
}
