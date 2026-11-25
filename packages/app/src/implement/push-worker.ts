// The Web Push service worker (ADR-0088): one fixed script of the framework release, served at
// `/__fabrika/push/worker.js` under the row's own access and registered with the scope `/__fabrika/push/`, where no page
// lives. It has no `fetch` handler and uses no cache, so it stands between no request of the application and the
// network. It ignores a push's payload (`event.data`): what it shows is only what the inbox answers under the person's
// session, read through the proxy when the push arrives. Plain script, no module syntax, nothing evaluated from a string.
//
// It talks to two rows: `POST /__fabrika/push/subscription` (`implement/push-subscription.ts`), and
// `POST /__fabrika/push/inbox` (answering `PushInboxAnswer`, `dispatch.ts`'s `#pushInbox`). Until the sender ships no
// push reaches it: nothing sends one.

import { PUSH_PREFIX } from '../contract/defaults'

/** What the inbox answers the worker: the caller's unseen notifications for this subscription, or that it is not theirs. */
export interface PushInboxAnswer {
	/** `false`: the subscription is bound to another person; the worker unsubscribes the browser. */
	readonly mine: boolean
	readonly notifications: readonly { readonly id: string; readonly title: string; readonly body: string; readonly path: string }[]
	/** How many more unseen notifications the inbox held beyond those it answered. */
	readonly more: number
}

/** At most this many notifications are shown for one push; the rest become one summary. */
export const PUSH_SHOWN_PER_PUSH = 5

/** The one tag of the fixed notice, so each one replaces the last instead of stacking. */
export const PUSH_NOTICE_TAG = 'fabrika-notice'

export const PUSH_WORKER_SCRIPT = `'use strict'
const INBOX = '${PUSH_PREFIX}/inbox'
const SUBSCRIPTION = '${PUSH_PREFIX}/subscription'
const NOTICE_TAG = '${PUSH_NOTICE_TAG}'
const MORE_TAG = 'fabrika-more'
const SHOWN = ${PUSH_SHOWN_PER_PUSH}
const DATABASE = 'fabrika-push'

function inStore(mode, work) {
	return new Promise(function (resolve, reject) {
		const opening = indexedDB.open(DATABASE, 1)
		opening.onupgradeneeded = function () { opening.result.createObjectStore('state') }
		opening.onerror = function () { reject(opening.error) }
		opening.onsuccess = function () {
			const database = opening.result
			const transaction = database.transaction('state', mode)
			const request = work(transaction.objectStore('state'))
			transaction.oncomplete = function () { database.close(); resolve(request.result) }
			transaction.onerror = function () { database.close(); reject(transaction.error) }
		}
	})
}
function stored(key) { return inStore('readonly', function (state) { return state.get(key) }).catch(function () { return undefined }) }
function store(key, value) { return inStore('readwrite', function (state) { return state.put(value, key) }) }

// A same-origin path: no control character (the URL parser drops tab and newlines, so '/<TAB>/x' would read as '//x'),
// no backslash, no scheme-relative start, and it must resolve to this origin.
function isPath(path) {
	if (typeof path !== 'string' || path.charAt(0) !== '/' || path.charAt(1) === '/' || path.indexOf('\\\\') !== -1) return false
	for (let index = 0; index < path.length; index++) {
		const code = path.charCodeAt(index)
		if (code < 0x20 || code === 0x7f) return false
	}
	try {
		return new URL(path, self.location.origin).origin === self.location.origin
	} catch (failure) {
		return false
	}
}
function isNotification(value) {
	return value !== null && typeof value === 'object' && typeof value.id === 'string' && typeof value.title === 'string'
		&& typeof value.body === 'string' && isPath(value.path)
}

// The page writes { name, notice, more } in the person's language when it subscribes; nothing else is kept here.
async function presentation() {
	const kept = await stored('presentation')
	return {
		name: kept && typeof kept.name === 'string' ? kept.name : self.location.hostname,
		notice: kept && typeof kept.notice === 'string' ? kept.notice : 'Open to see what is new',
		more: kept && typeof kept.more === 'string' ? kept.more : '+{count}',
	}
}
async function showNotice() {
	const words = await presentation()
	return self.registration.showNotification(words.name, { body: words.notice, tag: NOTICE_TAG, data: { path: '/' } })
}
async function closeShown() {
	const shown = await self.registration.getNotifications()
	for (const notification of shown) notification.close()
}
function post(path, body) {
	return fetch(path, {
		method: 'POST',
		credentials: 'same-origin',
		redirect: 'error',
		cache: 'no-store',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

function unsubscribe(subscription) {
	return subscription.unsubscribe().catch(function () { return false })
}

// Every push shows a notification, whatever fails on the way: a push that shows none costs the permission.
async function onPush() {
	try {
		await readInbox()
	} catch (failure) {
		await showNotice().catch(function () {})
	}
}

async function readInbox() {
	const subscription = await self.registration.pushManager.getSubscription()
	if (subscription === null) return showNotice()
	let response
	try {
		response = await post(INBOX, { endpoint: subscription.endpoint })
	} catch (failure) {
		return showNotice()
	}
	if (response.status === 401) {
		await closeShown()
		return showNotice()
	}
	if (response.status === 403) {
		await closeShown()
		await unsubscribe(subscription)
		return showNotice()
	}
	const answer = response.ok ? await response.json().catch(function () { return null }) : null
	if (answer === null || typeof answer !== 'object') return showNotice()
	if (answer.mine === false) {
		await unsubscribe(subscription)
		return showNotice()
	}
	const unseen = Array.isArray(answer.notifications) ? answer.notifications.filter(isNotification) : []
	if (unseen.length === 0) return showNotice()
	const shown = unseen.slice(0, SHOWN)
	for (const notification of shown) {
		await self.registration.showNotification(notification.title, { body: notification.body, tag: 'fabrika-n-' + notification.id, data: { path: notification.path } })
	}
	const more = unseen.length - shown.length + (typeof answer.more === 'number' && answer.more > 0 ? answer.more : 0)
	if (more > 0) {
		const words = await presentation()
		await self.registration.showNotification(words.name, { body: words.more.replace('{count}', String(more)), tag: MORE_TAG, data: { path: '/' } })
	}
}

async function open(path) {
	const target = new URL(isPath(path) ? path : '/', self.location.origin).href
	const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
	for (const client of windows) {
		if (client.url === target && 'focus' in client) return client.focus()
	}
	return self.clients.openWindow(target)
}

// The VAPID public key a subscription was made with, unpadded base64url as the subscription row compares it.
function keyOf(subscription) {
	const key = subscription.options && subscription.options.applicationServerKey
	if (!key) return null
	const bytes = new Uint8Array(key)
	let text = ''
	for (let index = 0; index < bytes.length; index++) text += String.fromCharCode(bytes[index])
	return btoa(text).replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '')
}

// A changed subscription is recorded as a replacement of the old one, which the row accepts only for the person the
// old one was bound to. Without a session the pair is kept for the page to post at its next load.
// While a pair is pending, a further change keeps the first old endpoint: only that one is known to the row.
async function onChange(previous, next) {
	const current = next || (previous ? await self.registration.pushManager.subscribe(previous.options).catch(function () { return null }) : null)
	if (!previous || !current) return
	const key = keyOf(current)
	const pending = await stored('replacement')
	const replace = pending && typeof pending.replace === 'string' ? pending.replace : previous.endpoint
	const replacement = { op: 'record', replace: replace, subscription: current.toJSON(), key: key }
	// A subscription that does not report its key cannot be recorded here: the page keeps the pair and adds the key it
	// subscribes with, as after a change without a session.
	if (key === null) {
		await store('replacement', replacement)
		return
	}
	try {
		const response = await post(SUBSCRIPTION, replacement)
		if (response.ok) {
			await inStore('readwrite', function (state) { return state.delete('replacement') }).catch(function () {})
			return
		}
	} catch (failure) {}
	await store('replacement', replacement)
}

self.addEventListener('install', function () { self.skipWaiting() })
self.addEventListener('push', function (event) { event.waitUntil(onPush()) })
self.addEventListener('notificationclick', function (event) {
	event.notification.close()
	event.waitUntil(open(event.notification.data && event.notification.data.path))
})
self.addEventListener('pushsubscriptionchange', function (event) {
	event.waitUntil(onChange(event.oldSubscription, event.newSubscription))
})
`

/** The worker's answer; the dispatcher has already authorized the caller, and the header policy is added after it. */
export function pushWorkerResponse(): Response {
	return new Response(PUSH_WORKER_SCRIPT, { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8' } })
}
