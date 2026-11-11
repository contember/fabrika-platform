// The demo's screens and their paths, served by the SPA mount at `/`.

import { createRouter } from '@fabrika/ui'

export const router = createRouter({
	orders: '/',
	customers: '/odberatele',
	billing: '/fakturace',
})

export const { Link, href, navigate, useRoute } = router
