import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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
})

describe('Router', () => {
	const router = createRouter(routes)
	const { Router, Link, useRoute, navigate } = router

	function Screen() {
		const route = useRoute()
		const title = route === null ? 'Not found' : route.name === 'deal' ? `Deal ${route.params.id}` : route.name
		return (
			<main>
				<PageHeader title={title} />
				<Link to="deals">All deals</Link>
				<Link to="deal" params={{ id: '42' }}>
					Deal 42
				</Link>
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

	test('popstate updates the route', async () => {
		const root = await mountApp()
		await act(async () => {
			window.history.pushState(null, '', '/deals/new')
			window.dispatchEvent(new PopStateEvent('popstate'))
		})
		expect(heading(root).textContent).toBe('newDeal')
	})
})
