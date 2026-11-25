import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { PageHeader } from '../PageHeader'
import { type CreatedRouter, createRouter, type ParamsOf, type RouteMatch } from '../router'
import { click, mount, type Mounted, query } from './dom'

const routes = { home: '/', deals: '/deals', newDeal: '/deals/new', deal: '/deals/:id', note: '/deals/:id/notes/:noteId' } as const
type Routes = typeof routes

let mounted: Mounted | undefined
beforeEach(() => {
	window.history.replaceState(null, '', '/')
})
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

async function routeAt(router: CreatedRouter<Routes>, path: string): Promise<RouteMatch<Routes> | null> {
	window.history.replaceState(null, '', path)
	let seen: RouteMatch<Routes> | null = null
	function Probe() {
		seen = router.useRoute()
		return null
	}
	const probe = await mount(<Probe />)
	await probe.unmount()
	return seen
}

describe('route matching', () => {
	const router = createRouter(routes)

	test('a path that matches no route answers null', async () => {
		expect(await routeAt(router, '/contacts')).toBeNull()
		expect(await routeAt(router, '/deals/1/extra')).toBeNull()
	})

	test('a param that does not decode does not match', async () => {
		expect(await routeAt(router, '/deals/%E0%A4%A')).toBeNull()
	})

	test('params are decoded, and a static segment beats a param', async () => {
		expect(await routeAt(router, '/deals/a%2Fb%20c')).toEqual({ name: 'deal', params: { id: 'a/b c' } })
		expect(await routeAt(router, '/deals/new')).toEqual({ name: 'newDeal', params: {} })
		expect(await routeAt(router, '/deals/7/notes/n1')).toEqual({ name: 'note', params: { id: '7', noteId: 'n1' } })
	})

	test('a trailing slash, the query and the hash do not matter', async () => {
		expect(await routeAt(router, '/deals/')).toEqual({ name: 'deals', params: {} })
		expect(await routeAt(router, '/deals?stage=won#top')).toEqual({ name: 'deals', params: {} })
		expect(await routeAt(router, '/')).toEqual({ name: 'home', params: {} })
	})

	test('base is stripped on read and a path outside it does not match', async () => {
		const based = createRouter(routes, { base: '/crm/' })
		expect(await routeAt(based, '/deals')).toBeNull()
		expect(await routeAt(based, '/crmx/deals')).toBeNull()
		expect(await routeAt(based, '/crm')).toEqual({ name: 'home', params: {} })
		expect(await routeAt(based, '/crm/deals/9')).toEqual({ name: 'deal', params: { id: '9' } })
	})

	test('a pattern must start with a slash and must not repeat a param', () => {
		expect(() => createRouter({ bad: 'deals' })).toThrow("must start with '/'")
		expect(() => createRouter({ bad: '/a/:id/b/:id' })).toThrow('repeated param')
	})
})

describe('href', () => {
	test('is typed from the table, encodes params and adds the base', () => {
		const router = createRouter(routes, { base: '/crm' })
		const params: ParamsOf<'/deals/:id/notes/:noteId'> = { id: 'a/b', noteId: 'n 1' }
		expect(router.href('deals')).toBe('/crm/deals')
		expect(router.href('home')).toBe('/crm/')
		expect(router.href('note', params)).toBe('/crm/deals/a%2Fb/notes/n%201')
		expect(createRouter(routes).href('deal', { id: '5' })).toBe('/deals/5')
	})

	test('adds a query: encoded, an array repeats its key, an undefined entry is left out', () => {
		const router = createRouter(routes, { base: '/crm' })
		expect(router.href('deals', { query: { stage: 'won & lost', owner: ['a', 'b'], empty: undefined } })).toBe(
			'/crm/deals?stage=won+%26+lost&owner=a&owner=b',
		)
		expect(router.href('deal', { id: '5' }, { query: { tab: 'notes' } })).toBe('/crm/deals/5?tab=notes')
		expect(router.href('deals', { query: {} })).toBe('/crm/deals')
		expect(router.href('deals', { query: { gone: undefined, none: [] } })).toBe('/crm/deals')
	})
})

describe('Router', () => {
	const router = createRouter(routes)
	const { Router, Link, useRoute, useSearchParams, navigate } = router

	function Screen() {
		const route = useRoute()
		const search = useSearchParams()
		const title = route === null ? 'Not found' : route.name === 'deal' ? `Deal ${route.params.id}` : route.name
		return (
			<main>
				<PageHeader title={title} />
				<output data-testid="stage">{search.getAll('stage').join(',')}</output>
				<Link to="deals">All deals</Link>
				<Link to="deals" query={{ stage: 'won' }}>
					Won deals
				</Link>
				<Link to="deal" params={{ id: '42' }}>
					Deal 42
				</Link>
				<a href="/deals?stage=lost" data-testid="lost">
					Lost
				</a>
				<a href="/deals/7" data-testid="plain">
					Plain
				</a>
				<a href="/deals/8" target="_blank" rel="noopener" data-testid="blank">
					Blank
				</a>
				<a href="/deals/9" download data-testid="download">
					Download
				</a>
				<a href="/deals/10" data-router="native" data-testid="native">
					Native
				</a>
				<a href="https://elsewhere.test/deals/1" data-testid="other">
					Other
				</a>
				<a href="#notes" data-testid="hash">
					Notes
				</a>
			</main>
		)
	}

	const mountApp = async () => {
		mounted = await mount(
			<Router>
				<Screen />
			</Router>,
		)
		return mounted.container
	}
	const heading = (root: HTMLElement) => query(root, 'h1', HTMLElement)
	const stage = (root: HTMLElement) => query(root, '[data-testid="stage"]', HTMLOutputElement).textContent
	const linkByText = (root: HTMLElement, text: string) => {
		const link = [...root.querySelectorAll('a')].find((anchor) => anchor.textContent === text)
		if (link === undefined) throw new Error(`no link ${text}`)
		return link
	}
	/** Mounts the app on `path` with focus on a control outside the heading, and counts the router's scrolls to the top. */
	const mountAt = async (path: string) => {
		window.history.replaceState(null, '', path)
		const root = await mountApp()
		const control = document.createElement('button')
		document.body.append(control)
		control.focus()
		const scroll = spyOn(window, 'scrollTo').mockImplementation(() => {})
		return { root, control, scroll }
	}

	test('a click with a modifier key, a target, a download, a native opt-out, another origin or another button is not intercepted', async () => {
		const root = await mountApp()
		expect(await click(query(root, '[data-testid="plain"]', HTMLAnchorElement), { metaKey: true })).toBe(false)
		expect(await click(query(root, '[data-testid="plain"]', HTMLAnchorElement), { ctrlKey: true })).toBe(false)
		expect(await click(query(root, '[data-testid="plain"]', HTMLAnchorElement), { button: 1 })).toBe(false)
		for (const id of ['blank', 'download', 'native', 'other', 'hash']) {
			expect(await click(query(root, `[data-testid="${id}"]`, HTMLAnchorElement))).toBe(false)
		}
		expect(heading(root).textContent).toBe('home')
	})

	test('a click on a plain in-app link navigates with pushState, scrolls up and focuses the heading', async () => {
		const root = await mountApp()
		const length = window.history.length
		expect(await click(query(root, '[data-testid="plain"]', HTMLAnchorElement))).toBe(true)
		expect(window.location.pathname).toBe('/deals/7')
		expect(window.history.length).toBe(length + 1)
		expect(heading(root).textContent).toBe('Deal 7')
		expect(document.activeElement).toBe(heading(root))
	})

	test('Link renders the typed href and marks the current route', async () => {
		const root = await mountApp()
		const link = [...root.querySelectorAll('a')].find((anchor) => anchor.textContent === 'Deal 42')
		expect(link?.getAttribute('href')).toBe('/deals/42')
		expect(link?.hasAttribute('aria-current')).toBe(false)
		if (link) await click(link)
		expect(heading(root).textContent).toBe('Deal 42')
		expect(link?.getAttribute('aria-current')).toBe('page')
	})

	test('navigate works outside components and replace does not add an entry', async () => {
		const root = await mountApp()
		const length = window.history.length
		await act(async () => navigate('deal', { id: '3' }, { replace: true }))
		expect(window.location.pathname).toBe('/deals/3')
		expect(window.history.length).toBe(length)
		await act(async () => navigate('deals'))
		expect(window.history.length).toBe(length + 1)
		expect(heading(root).textContent).toBe('deals')
	})

	test('Link and navigate carry a query, and useSearchParams follows it', async () => {
		const root = await mountApp()
		expect(linkByText(root, 'Won deals').getAttribute('href')).toBe('/deals?stage=won')
		await act(async () => navigate('deals', { query: { stage: ['won', 'open'] } }))
		expect(window.location.pathname + window.location.search).toBe('/deals?stage=won&stage=open')
		expect(stage(root)).toBe('won,open')
		await act(async () => navigate('deal', { id: '3' }, { query: { stage: 'lost' }, replace: true }))
		expect(window.location.pathname + window.location.search).toBe('/deals/3?stage=lost')
		expect(stage(root)).toBe('lost')
	})

	test('a link is current by its path, whatever the query', async () => {
		const root = await mountApp()
		await act(async () => navigate('deals', { query: { stage: 'open' } }))
		expect(linkByText(root, 'All deals').getAttribute('aria-current')).toBe('page')
		expect(linkByText(root, 'Won deals').getAttribute('aria-current')).toBe('page')
	})

	test('a navigation that changes only the query keeps the scroll and the focus', async () => {
		const { root, control, scroll } = await mountAt('/deals')
		try {
			await act(async () => navigate('deals', { query: { stage: 'open' } }))
			expect(await click(linkByText(root, 'Won deals'))).toBe(true)
			await click(query(root, '[data-testid="lost"]', HTMLAnchorElement))
			expect(window.location.search).toBe('?stage=lost')
			expect(stage(root)).toBe('lost')
			expect(scroll).not.toHaveBeenCalled()
			expect(document.activeElement).toBe(control)
		} finally {
			scroll.mockRestore()
		}
	})

	test('a navigation to another path, or to the same URL, scrolls up and focuses the heading', async () => {
		const { root, scroll } = await mountAt('/deals?stage=won')
		try {
			await click(linkByText(root, 'Won deals'))
			expect(scroll).toHaveBeenCalledTimes(1)
			expect(document.activeElement).toBe(heading(root))
			await act(async () => navigate('deal', { id: '5' }, { query: { stage: 'won' } }))
			expect(scroll).toHaveBeenCalledTimes(2)
			expect(heading(root).textContent).toBe('Deal 5')
			expect(document.activeElement).toBe(heading(root))
		} finally {
			scroll.mockRestore()
		}
	})

	test('popstate updates the query', async () => {
		const root = await mountApp()
		await act(async () => {
			window.history.pushState(null, '', '/?stage=won')
			window.dispatchEvent(new PopStateEvent('popstate'))
		})
		expect(stage(root)).toBe('won')
	})

	test('popstate updates the route', async () => {
		const root = await mountApp()
		await act(async () => {
			window.history.pushState(null, '', '/deals/new')
			window.dispatchEvent(new PopStateEvent('popstate'))
		})
		expect(heading(root).textContent).toBe('newDeal')
	})
})
