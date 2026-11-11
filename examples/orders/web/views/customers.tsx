// The customers: the owner reads all of them with their salesperson, a salesperson only the ones assigned to them.

import { useCaller, useInfiniteQuery, useQuery } from '@fabrika/app/react'
import { type Column, DataTable, PageHeader } from '@fabrika/ui'
import type { ReactNode } from 'react'
import { api, type Customer, type Rep } from '../api'
import { describe, tableState } from './common'

function AllCustomers(): ReactNode {
	const customers = useInfiniteQuery(api.customers.list, {})
	const reps = useQuery(api.customers.reps)
	const repOf = (id: string): string => {
		if (reps.status !== 'success') return '…'
		return reps.data.items.filter((rep) => rep.customerId === id).map((rep) => rep.label).join(', ') || 'nepřidělen'
	}
	const columns: readonly Column<Customer>[] = [
		{ key: 'name', header: 'Odběratel', grow: true, cell: (customer) => customer.name },
		{ key: 'city', header: 'Město', cell: (customer) => customer.city },
		{ key: 'ico', header: 'IČO', cell: (customer) => customer.ico },
		{ key: 'email', header: 'E-mail', cell: (customer) => customer.email },
		{ key: 'rep', header: 'Obchodník', cell: (customer) => repOf(customer.id) },
	]
	return (
		<>
			<PageHeader title="Odběratelé" lead="Všichni odběratelé pražírny a obchodník, který je má na starosti." />
			<DataTable
				caption="Odběratelé"
				columns={columns}
				rows={customers.items}
				rowKey={(customer) => customer.id}
				{...tableState(customers)}
				empty="Žádní odběratelé."
			/>
		</>
	)
}

function MyCustomers(): ReactNode {
	const reps = useQuery(api.customers.reps)
	const columns: readonly Column<Rep>[] = [
		{ key: 'name', header: 'Odběratel', grow: true, cell: (rep) => rep.customerName },
		{ key: 'city', header: 'Město', cell: (rep) => rep.customerCity },
	]
	return (
		<>
			<PageHeader title="Moji odběratelé" lead="Vidíš jen odběratele, které ti přidělila majitelka. Ostatní pro tebe neexistují." />
			<DataTable
				caption="Moji odběratelé"
				columns={columns}
				rows={reps.status === 'success' ? reps.data.items : []}
				rowKey={(rep) => rep.id}
				status={reps.status === 'success' ? 'ready' : reps.status === 'error' ? 'error' : 'loading'}
				{...(reps.status === 'error' ? { error: describe(reps.error).message } : {})}
				onRetry={() => void reps.refetch()}
				empty="Zatím ti nikdo nepřidělil žádného odběratele."
			/>
		</>
	)
}

export function Customers(): ReactNode {
	const caller = useCaller()
	if (caller === null) return null
	return caller.can('customers.write') ? <AllCustomers /> : <MyCustomers />
}
