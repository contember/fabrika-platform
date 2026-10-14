// The CRM's screens and their paths, served by the SPA mount at `/`.

import { createRouter } from '@fabrika/ui'

export const router = createRouter({
	pipeline: '/',
	deals: '/deals',
	deal: '/deals/:id',
	contacts: '/contacts',
	contact: '/contacts/:id',
	companies: '/companies',
	tasks: '/tasks',
})

export const { Link, href, navigate, useRoute } = router
