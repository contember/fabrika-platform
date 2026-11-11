// Who may call what: the customers and their salespeople, the orders, the invoicing records, and the SPA. The proxy
// enforces this file's endpoint table and the data layer the policies of src/db/tables.ts.

import { app } from './src/app-kit'
import { billing } from './src/billing/endpoints'
import { customers } from './src/customers/endpoints'
import { orders } from './src/orders/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { customers, orders, billing }),
	site: c.spa('/', { dir: 'dist/web', access: { action: 'orders.read', over: 'customer' } }),
	health: c.health('/healthz'),
}))
