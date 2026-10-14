// The CRM's page: the provider over the clients, the toasts, the router, and the shell with the screen of the route.

import type { RpcFetch } from '@fabrika/app/client'
import { FabrikaProvider, useCaller, useInfiniteQuery, useQuery } from '@fabrika/app/react'
import { AppShell, EmptyState, type NavItem, ToastProvider } from '@fabrika/ui'
import type { ReactNode } from 'react'
import { api } from './api'
import { href, router, useRoute } from './routes'
import { Companies } from './views/companies'
import { Contacts, ContactView } from './views/contacts'
import { DealView } from './views/deal'
import { Deals } from './views/deals'
import { Pipeline } from './views/pipeline'
import { Tasks } from './views/tasks'

function Screen(): ReactNode {
	const route = useRoute()
	switch (route?.name) {
		case 'pipeline':
			return <Pipeline />
		case 'deals':
			return <Deals />
		case 'deal':
			return <DealView key={route.params.id} id={route.params.id} />
		case 'contacts':
			return <Contacts />
		case 'contact':
			return <ContactView key={route.params.id} id={route.params.id} />
		case 'companies':
			return <Companies />
		case 'tasks':
			return <Tasks />
		case undefined:
			return <EmptyState title="Nothing here" text="This address names no screen of the CRM." />
	}
}

function Shell(): ReactNode {
	const route = useRoute()
	const caller = useCaller()
	const pipeline = useQuery(api.deals.pipeline)
	const tasks = useInfiniteQuery(api.tasks.list, {}, { pages: 'all' })
	const openDeals = pipeline.status === 'success'
		? pipeline.data.stages.filter((stage) => stage.stage !== 'won' && stage.stage !== 'lost').reduce((sum, stage) => sum + stage.count, 0)
		: undefined
	const openTasks = tasks.status === 'success' ? tasks.items.filter((task) => !task.done).length : undefined
	const nav: readonly NavItem[] = [
		{ label: 'Pipeline', href: href('pipeline'), active: route?.name === 'pipeline' },
		{ label: 'Deals', href: href('deals'), active: route?.name === 'deals' || route?.name === 'deal', count: openDeals },
		{ label: 'Contacts', href: href('contacts'), active: route?.name === 'contacts' || route?.name === 'contact' },
		{ label: 'Companies', href: href('companies'), active: route?.name === 'companies' },
		{ label: 'Tasks', href: href('tasks'), active: route?.name === 'tasks', count: openTasks },
	]
	return (
		<AppShell
			brand={<span className="crm-brand">CRM</span>}
			nav={nav}
			user={caller === null ? null : (
				<span className="crm-caller">
					<span className="crm-caller__label">{caller.label}</span>
					<span className="crm-caller__email">{caller.email}</span>
				</span>
			)}
		>
			<Screen />
		</AppShell>
	)
}

export interface CrmProps {
	/** The client of `/api`; the page's own, or one over the test kit. */
	readonly clients: readonly object[]
	/** What the caller document is read with; the page's `fetch` by default. */
	readonly fetch?: RpcFetch
}

export function Crm({ clients, fetch }: CrmProps): ReactNode {
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
