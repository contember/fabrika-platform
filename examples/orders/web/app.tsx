// The demo's page: the provider over the clients, the toasts, the router, and the shell with the screen of the route.
// The navigation shows what the person's role reaches; every endpoint decides again on its own.

import type { RpcFetch } from '@fabrika/app/client'
import { FabrikaProvider, useCaller } from '@fabrika/app/react'
import { AppShell, EmptyState, type NavItem, ToastProvider } from '@fabrika/ui'
import type { ReactNode } from 'react'
import { href, router, useRoute } from './routes'
import { Billing } from './views/billing'
import { Customers } from './views/customers'
import { Orders as OrderList } from './views/orders'

function Screen(): ReactNode {
	const route = useRoute()
	switch (route?.name) {
		case 'orders':
			return <OrderList />
		case 'customers':
			return <Customers />
		case 'billing':
			return <Billing />
		case undefined:
			return <EmptyState title="Tady nic není" text="Tahle adresa nevede na žádnou obrazovku." />
	}
}

function Shell(): ReactNode {
	const route = useRoute()
	const caller = useCaller()
	const nav: NavItem[] = [{ label: 'Objednávky', href: href('orders'), active: route?.name === 'orders' }]
	if (caller?.can('customers.read') === true) {
		nav.push({ label: 'Odběratelé', href: href('customers'), active: route?.name === 'customers' })
	}
	if (caller?.can('billing.read') === true) {
		nav.push({ label: 'Fakturace', href: href('billing'), active: route?.name === 'billing' })
	}
	return (
		<AppShell
			brand={<span className="orders-brand">Pražírna Zrnko · Objednávky</span>}
			nav={nav}
			navLabel="Hlavní"
			user={caller === null ? null : (
				<span className="orders-caller">
					<span className="orders-caller__label">{caller.label}</span>
					<span className="orders-caller__email">{caller.email}</span>
				</span>
			)}
		>
			<Screen />
		</AppShell>
	)
}

export interface OrdersProps {
	/** The client of `/api`; the page's own, or one over the test kit. */
	readonly clients: readonly object[]
	/** What the caller document is read with; the page's `fetch` by default. */
	readonly fetch?: RpcFetch
}

export function Orders({ clients, fetch }: OrdersProps): ReactNode {
	return (
		<FabrikaProvider clients={clients} fetch={fetch}>
			<ToastProvider>
				<router.Router>
					<Shell />
				</router.Router>
			</ToastProvider>
		</FabrikaProvider>
	)
}
