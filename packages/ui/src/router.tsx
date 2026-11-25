import { type ComponentProps, type ReactNode, useEffect, useMemo, useSyncExternalStore } from 'react'

type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}` ? Name | ParamNames<`/${Rest}`>
	: P extends `${string}:${infer Name}` ? Name
	: never

/** The params of a path pattern: `ParamsOf<'/deals/:id'>` is `{ readonly id: string }`. */
export type ParamsOf<P extends string> = { readonly [Name in ParamNames<P>]: string }

/** A route name → path pattern table, such as `{ deals: '/deals', deal: '/deals/:id' }`. */
export type RouteTable = Readonly<Record<string, string>>

type RouteName<R extends RouteTable> = keyof R & string

/** A pattern without params takes no params argument; one with params requires them. */
export type ParamsArgs<P extends string> = [ParamNames<P>] extends [never] ? [] : [params: ParamsOf<P>]

export type RouteMatch<R extends RouteTable> = {
	[Name in RouteName<R>]: { readonly name: Name; readonly params: ParamsOf<R[Name]> }
}[RouteName<R>]

export interface RouterOptions {
	/** The path the application is mounted under; it is stripped when matching and added by `href`. */
	readonly base?: string
}

/** A URL query: an `undefined` value leaves its key out, an array repeats the key once per value. */
export type QueryInit = Readonly<Record<string, string | readonly string[] | undefined>>

export interface HrefOptions {
	readonly query?: QueryInit
}

export interface NavigateOptions extends HrefOptions {
	readonly replace?: boolean
}

export type LinkProps<R extends RouteTable, Name extends RouteName<R>> =
	& Readonly<Omit<ComponentProps<'a'>, 'href'>>
	& { readonly to: Name; readonly query?: QueryInit }
	& ([ParamNames<R[Name]>] extends [never] ? { readonly params?: undefined } : { readonly params: ParamsOf<R[Name]> })

export interface RouterProps {
	readonly children: ReactNode
}

export interface CreatedRouter<R extends RouteTable> {
	readonly Router: (props: RouterProps) => ReactNode
	readonly Link: <Name extends RouteName<R>>(props: LinkProps<R, Name>) => ReactNode
	readonly useRoute: () => RouteMatch<R> | null
	/** The current URL's query; a new instance when the query changes. Read it, and change it through `navigate`. */
	readonly useSearchParams: () => URLSearchParams
	readonly href: <Name extends RouteName<R>>(name: Name, ...args: [...ParamsArgs<R[Name]>, options?: HrefOptions]) => string
	readonly navigate: <Name extends RouteName<R>>(name: Name, ...args: [...ParamsArgs<R[Name]>, options?: NavigateOptions]) => void
}

type Segment = { readonly kind: 'static'; readonly value: string } | { readonly kind: 'param'; readonly name: string }

interface CompiledRoute {
	readonly name: string
	readonly segments: readonly Segment[]
}

interface LocationSnapshot {
	readonly pathname: string
	readonly search: string
	/**
	 * Set by a navigation this router made to another path, or to the same URL again, so the page scrolls to the top and
	 * focus moves to its heading. A navigation that changes only the query (a filter) keeps both.
	 */
	readonly announce: boolean
}

function splitPath(path: string): string[] {
	return path.split('/').filter((segment) => segment !== '')
}

function compile(name: string, pattern: string): CompiledRoute {
	if (!pattern.startsWith('/')) throw new Error(`route ${name}: pattern ${JSON.stringify(pattern)} must start with '/'`)
	const seen = new Set<string>()
	const segments = splitPath(pattern).map((segment): Segment => {
		if (!segment.startsWith(':')) return { kind: 'static', value: segment }
		const param = segment.slice(1)
		if (param === '' || seen.has(param)) throw new Error(`route ${name}: pattern ${JSON.stringify(pattern)} has an empty or repeated param`)
		seen.add(param)
		return { kind: 'param', name: param }
	})
	return { name, segments }
}

/** A static segment outranks a param at the first position where two patterns differ: `/deals/new` beats `/deals/:id`. */
function bySpecificity(left: CompiledRoute, right: CompiledRoute): number {
	const length = Math.min(left.segments.length, right.segments.length)
	for (let index = 0; index < length; index++) {
		const leftKind = left.segments[index]?.kind
		const rightKind = right.segments[index]?.kind
		if (leftKind !== rightKind) return leftKind === 'static' ? -1 : 1
	}
	return 0
}

function decodeSegment(segment: string): string | undefined {
	try {
		return decodeURIComponent(segment)
	} catch {
		return undefined
	}
}

function matchSegments(route: CompiledRoute, parts: readonly string[]): Record<string, string> | undefined {
	if (route.segments.length !== parts.length) return undefined
	const params: Record<string, string> = {}
	for (const [index, segment] of route.segments.entries()) {
		const part = parts[index]
		if (part === undefined) return undefined
		if (segment.kind === 'static') {
			if (segment.value !== part) return undefined
			continue
		}
		const value = decodeSegment(part)
		if (value === undefined) return undefined
		params[segment.name] = value
	}
	return params
}

function normalizeBase(base: string): string {
	const trimmed = base.replace(/\/+$/, '')
	if (trimmed === '') return ''
	return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
	return typeof value === 'object' && value !== null && Object.values(value).every((entry) => typeof entry === 'string')
}

function isNavigateOptions(value: unknown): value is NavigateOptions {
	return typeof value === 'object' && value !== null
}

function searchOf(query: QueryInit | undefined): string {
	const search = new URLSearchParams()
	for (const [name, value] of Object.entries(query ?? {})) {
		if (value === undefined) continue
		for (const item of typeof value === 'string' ? [value] : value) search.append(name, item)
	}
	const text = search.toString()
	return text === '' ? '' : `?${text}`
}

/**
 * A typed History API router over a route table. Every function it answers is typed from `routes`, and `Router` turns
 * every plain same-origin `<a href>` under `base` into an in-app navigation.
 */
export function createRouter<const R extends RouteTable>(routes: R, options: RouterOptions = {}): CreatedRouter<R> {
	const base = normalizeBase(options.base ?? '/')
	const compiled = Object.entries(routes).map(([name, pattern]) => compile(name, pattern)).sort(bySpecificity)
	const byName = new Map(compiled.map((route) => [route.name, route]))
	const listeners = new Set<() => void>()
	let snapshot: LocationSnapshot | undefined

	function isRouteMatch(value: { readonly name: string; readonly params: Readonly<Record<string, string>> }): value is RouteMatch<R> {
		const route = byName.get(value.name)
		if (route === undefined) return false
		const names = route.segments.flatMap((segment) => segment.kind === 'param' ? [segment.name] : [])
		return names.length === Object.keys(value.params).length && names.every((name) => Object.hasOwn(value.params, name))
	}

	function stripBase(pathname: string): string | undefined {
		if (base === '') return pathname
		if (pathname === base) return '/'
		return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : undefined
	}

	function match(pathname: string): RouteMatch<R> | null {
		const path = stripBase(pathname)
		if (path === undefined) return null
		const parts = splitPath(path)
		for (const route of compiled) {
			const params = matchSegments(route, parts)
			if (params === undefined) continue
			const found = { name: route.name, params }
			if (isRouteMatch(found)) return found
		}
		return null
	}

	function buildHref(name: string, params: unknown, query?: QueryInit): string {
		const route = byName.get(name)
		if (route === undefined) throw new Error(`unknown route ${JSON.stringify(name)}`)
		const values = isStringRecord(params) ? params : {}
		const path = route.segments.map((segment) => {
			if (segment.kind === 'static') return segment.value
			const value = Object.hasOwn(values, segment.name) ? values[segment.name] : undefined
			if (value === undefined) throw new Error(`route ${name}: missing param ${segment.name}`)
			return encodeURIComponent(value)
		})
		return `${base}/${path.join('/')}${searchOf(query)}`
	}

	function hasParams(name: string): boolean {
		return byName.get(name)?.segments.some((segment) => segment.kind === 'param') ?? false
	}

	function getSnapshot(): LocationSnapshot {
		const { pathname, search } = window.location
		if (snapshot === undefined || snapshot.pathname !== pathname || snapshot.search !== search) snapshot = { pathname, search, announce: false }
		return snapshot
	}

	function notify(announce: boolean): void {
		snapshot = { pathname: window.location.pathname, search: window.location.search, announce }
		for (const listener of listeners) listener()
	}

	function subscribe(listener: () => void): () => void {
		listeners.add(listener)
		const onPopState = () => notify(false)
		window.addEventListener('popstate', onPopState)
		return () => {
			listeners.delete(listener)
			window.removeEventListener('popstate', onPopState)
		}
	}

	/**
	 * Moves to `url`. A new path scrolls up and focuses the heading; a new query alone keeps both, so a filter does not
	 * jump the page. A click on a link to the page already shown (`reclick`) scrolls up too, as a browser would.
	 */
	function go(url: string, replace: boolean, reclick: boolean): void {
		const { pathname, search } = window.location
		if (replace) window.history.replaceState(null, '', url)
		else window.history.pushState(null, '', url)
		const samePage = window.location.pathname === pathname && window.location.search === search
		notify(window.location.pathname !== pathname || (reclick && samePage))
	}

	function useLocation(): LocationSnapshot {
		return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
	}

	function interceptedUrl(event: globalThis.MouseEvent): URL | undefined {
		if (event.defaultPrevented || event.button !== 0) return undefined
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return undefined
		const anchor = event.target instanceof Element ? event.target.closest('a') : null
		if (!(anchor instanceof HTMLAnchorElement)) return undefined
		const href = anchor.getAttribute('href')
		const target = anchor.getAttribute('target')
		if (href === null || anchor.hasAttribute('download') || anchor.getAttribute('data-router') === 'native') return undefined
		if (target !== null && target !== '' && target !== '_self') return undefined
		const url = new URL(href, document.baseURI)
		if (url.origin !== window.location.origin || stripBase(url.pathname) === undefined) return undefined
		const samePage = url.pathname === window.location.pathname && url.search === window.location.search
		// A link to an anchor on the current page keeps the browser's own scroll to that anchor.
		if (samePage && url.hash !== '') return undefined
		return url
	}

	function Router({ children }: RouterProps): ReactNode {
		const location = useLocation()
		useEffect(() => {
			const onClick = (event: globalThis.MouseEvent) => {
				const url = interceptedUrl(event)
				if (url === undefined) return
				event.preventDefault()
				go(`${url.pathname}${url.search}${url.hash}`, false, true)
			}
			document.addEventListener('click', onClick)
			return () => document.removeEventListener('click', onClick)
		}, [])
		useEffect(() => {
			if (!location.announce) return
			window.scrollTo(0, 0)
			const heading = document.querySelector('main h1[tabindex="-1"]') ?? document.querySelector('h1[tabindex="-1"]')
			if (heading instanceof HTMLElement) heading.focus({ preventScroll: true })
		}, [location])
		return children
	}

	function useRoute(): RouteMatch<R> | null {
		return match(useLocation().pathname)
	}

	function useSearchParams(): URLSearchParams {
		const { search } = useLocation()
		// One instance per query, so an effect that depends on it reruns only when the query changes.
		return useMemo(() => new URLSearchParams(search), [search])
	}

	/** Splits the rest arguments of `href` and `navigate`: the params when the route has any, then the options. */
	function splitArgs(name: string, args: readonly unknown[]): { readonly params: unknown; readonly options: NavigateOptions } {
		const params = hasParams(name) ? args[0] : undefined
		const options = args[hasParams(name) ? 1 : 0]
		return { params, options: isNavigateOptions(options) ? options : {} }
	}

	function href<Name extends RouteName<R>>(name: Name, ...args: [...ParamsArgs<R[Name]>, options?: HrefOptions]): string {
		const { params, options } = splitArgs(name, args)
		return buildHref(name, params, options.query)
	}

	function navigate<Name extends RouteName<R>>(name: Name, ...args: [...ParamsArgs<R[Name]>, options?: NavigateOptions]): void {
		const { params, options } = splitArgs(name, args)
		go(buildHref(name, params, options.query), options.replace === true, false)
	}

	function Link<Name extends RouteName<R>>(props: LinkProps<R, Name>): ReactNode {
		const { to, params, query, children, ...rest } = props
		const location = useLocation()
		// Current by path alone: a navigation item stays current whatever query (filters) the page carries.
		const current = splitPath(location.pathname).join('/') === splitPath(buildHref(to, params)).join('/')
		return (
			<a {...rest} href={buildHref(to, params, query)} aria-current={rest['aria-current'] ?? (current ? 'page' : undefined)}>
				{children}
			</a>
		)
	}

	return { Router, Link, useRoute, useSearchParams, href, navigate }
}
