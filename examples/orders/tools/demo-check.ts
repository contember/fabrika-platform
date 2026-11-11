// A pre-flight of the webinar demo against a running `fabrika app dev` (`bun tools/demo-check.ts http://127.0.0.1:3000`):
// it picks each persona as the toolbar does, checks what each reaches, and walks the first scenario, accounting
// refused an order's delete. It changes nothing: the refused delete leaves the order in place. The application never
// loads this file.

import { z } from 'zod/v4'

const OrderPage = z.object({ items: z.array(z.object({ id: z.string(), number: z.string(), customerName: z.string(), version: z.number() })) })
const RepList = z.object({ items: z.array(z.object({ customerName: z.string() })) })
const Result = z.object({ result: z.unknown() })

/** Sends a request to the demo, by its path, as the browser that holds `cookie`. */
export type Send = (path: string, init: { readonly method?: string; readonly body?: unknown; readonly cookie?: string }) => Promise<Response>

export interface Check {
	readonly ok: boolean
	readonly line: string
}

async function personaCookie(send: Send, persona: string): Promise<string> {
	const answer = await send(`/__fabrika/dev/as?persona=${encodeURIComponent(persona)}&next=/`, {})
	const cookie = answer.headers.get('Set-Cookie')
	if (answer.status !== 303 || cookie === null) throw new Error(`the picker refused persona ${persona}: ${answer.status}`)
	return cookie.split(';')[0] ?? ''
}

const rpc = (send: Send, cookie: string, procedure: string, input: unknown): Promise<Response> =>
	send(`/api/${procedure}`, { method: 'POST', body: input, cookie })

/** The answer of a call that must succeed, or an error naming its status and body. */
async function answer(response: Promise<Response>): Promise<unknown> {
	const settled = await response
	const text = await settled.text()
	if (settled.status !== 200) throw new Error(`${settled.url || 'the call'} answered ${settled.status}: ${text.slice(0, 300)}`)
	return Result.parse(JSON.parse(text)).result
}

export async function runDemoCheck(send: Send): Promise<readonly Check[]> {
	const checks: Check[] = []
	const check = (ok: boolean, line: string) => checks.push({ ok, line })

	const page = await send('/', { cookie: await personaCookie(send, 'Jana') })
	const html = await page.text()
	check(page.status === 200 && html.includes('__fabrika/dev/toolbar.js'), `the SPA answers ${page.status} with the dev toolbar`)

	const jana = await personaCookie(send, 'Jana')
	const all = OrderPage.parse(await answer(rpc(send, jana, 'orders.list', {})))
	check(all.items.length === 7, `Jana (majitelka) reads all ${all.items.length} orders`)

	const petr = await personaCookie(send, 'Petr')
	const petrs = RepList.parse(await answer(rpc(send, petr, 'customers.reps', {})))
	const petrOrders = OrderPage.parse(await answer(rpc(send, petr, 'orders.list', {})))
	const names = petrs.items.map((rep) => rep.customerName).join(', ')
	check(
		petrs.items.length === 2
			&& petrOrders.items.every((order) => order.customerName === 'Kavárna U Modré lípy' || order.customerName === 'Bistro Na Rohu'),
		`Petr (obchodník) reads only his customers (${names}) and their ${petrOrders.items.length} orders`,
	)

	const lenka = await personaCookie(send, 'Lenka')
	const customers = await rpc(send, lenka, 'customers.list', {})
	check(customers.status === 403, `Lenka (účtárna) is refused the customers: ${customers.status}`)
	const target = all.items.find((order) => order.number === 'OBJ-2026-0412')
	if (target === undefined) {
		check(false, 'order OBJ-2026-0412 is missing: was the seed changed?')
		return checks
	}
	const refused = await rpc(send, lenka, 'orders.remove', { id: target.id, expectVersion: target.version })
	check(refused.status === 403, `Lenka's delete of ${target.number} is refused: ${refused.status}`)
	const still = OrderPage.parse(await answer(rpc(send, jana, 'orders.list', {})))
	check(still.items.some((order) => order.id === target.id), `${target.number} is still there`)
	return checks
}

if (import.meta.main) {
	const origin = process.argv[2] ?? 'http://127.0.0.1:3000'
	const send: Send = (path, init) =>
		fetch(new URL(path, origin), {
			method: init.method ?? 'GET',
			redirect: 'manual',
			headers: {
				...(init.cookie === undefined ? {} : { Cookie: init.cookie }),
				...(init.body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }),
			},
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		})
	const checks = await runDemoCheck(send)
	for (const { ok, line } of checks) console.info(`${ok ? 'OK  ' : 'CHYBA'} ${line}`)
	process.exit(checks.every((item) => item.ok) ? 0 : 1)
}
