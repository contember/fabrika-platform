// `c.webhook` for GitHub (the framework document, section 4). A holder of the bound dimension's `members.manage`
// creates a binding through the generated `webhooks.<name>.bind` endpoint; the framework generates the secret and
// keeps the binding in `fabrika_webhook_bindings`. A delivery is checked in a fixed order — the binding, the
// signature over the raw body, the account, the input, the delivery id — before its handler sees a `Ref` of the
// bound value only.

import type { WebhookTables } from '@fabrika/db/framework'
import { uuidv7 } from '@fabrika/platform'
import { z } from 'zod/v4'
import { joinPath, WEBHOOK_ACCOUNT_PATTERN, WEBHOOK_SCOPE_FIELD } from '../contract/defaults'
import { NotFoundError } from '../errors'
import { Ref } from './capability'

/** The input and output of the generated binding endpoints; `build.ts`'s `WEBHOOK_BIND_*` shapes describe them. */
export const webhookBindInput = z.strictObject({
	[WEBHOOK_SCOPE_FIELD]: z.string().min(1),
	account: z.string().regex(new RegExp(WEBHOOK_ACCOUNT_PATTERN)),
})
export const webhookBindOutput = z.strictObject({ id: z.uuid(), url: z.string().min(1), secret: z.string().min(1) })
export const webhookUnbindInput = z.strictObject({ [WEBHOOK_SCOPE_FIELD]: z.string().min(1), id: z.uuid() })
export const webhookUnbindOutput = z.strictObject({ id: z.uuid() })

/** The workload a delivery runs as: no person, only the binding. It creates no scope and manages no member. */
export interface WebhookPrincipal {
	readonly kind: 'webhook'
	readonly bindingId: string
}

/** The principal id a delivery's capabilities are granted to. */
export function webhookSubject(bindingId: string): string {
	return `webhook:${bindingId}`
}

/** GitHub's delivery id, for the log only: the header is not signed, so it decides nothing. */
const DELIVERY_ID = /^[A-Za-z0-9-]{1,100}$/

export function deliveryIdOf(request: Request): string | null {
	const id = request.headers.get('X-GitHub-Delivery')
	return id !== null && DELIVERY_ID.test(id) ? id : null
}

/**
 * A delivery key is kept this long per binding. GitHub signs no timestamp, so a body replayed after the window
 * runs again; GitHub itself redelivers for three days.
 */
export const WEBHOOK_REPLAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * `sha256:<hex>` of the binding id and the signed body: what replay protection and an idempotent handler key on.
 * A redelivery of one event has the same key, whatever its `X-GitHub-Delivery` says.
 */
export async function deliveryKey(bindingId: string, body: Uint8Array<ArrayBuffer>): Promise<string> {
	const id = new TextEncoder().encode(bindingId)
	const content = new Uint8Array(id.byteLength + body.byteLength)
	content.set(id, 0)
	content.set(body, id.byteLength)
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', content))
	return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** What a handler knows of its delivery. Handlers run at least once: write idempotently, keyed on `key`. */
export interface WebhookDelivery {
	readonly key: string
}

/** 32 random bytes as hex: the HMAC key GitHub signs with, shown once to the member who binds. */
function generateSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export interface BindingHandlers {
	bind(args: { readonly input: Readonly<Record<string, unknown>>; readonly ctx: object }): Promise<z.output<typeof webhookBindOutput>>
	unbind(args: { readonly input: Readonly<Record<string, unknown>>; readonly ctx: object }): Promise<z.output<typeof webhookUnbindOutput>>
}

/** What the `in` access form handed a binding endpoint: the checked `Ref` of the value, and the person. */
function accessOf(ctx: object): { readonly scope: Ref<string, string>; readonly principal: string } {
	const target: unknown = Reflect.get(ctx, 'target')
	const principal: unknown = Reflect.get(ctx, 'principal')
	const id: unknown = typeof principal === 'object' && principal !== null ? Reflect.get(principal, 'id') : undefined
	if (!(target instanceof Ref) || typeof id !== 'string') {
		throw new TypeError('a binding endpoint runs for a person, with the Ref of its in access form')
	}
	return { scope: target, principal: id }
}

/** The framework's handlers of `webhooks.<name>.bind` and `.unbind`. */
export function bindingHandlers(webhook: string, path: string, tables: () => WebhookTables): BindingHandlers {
	return {
		async bind({ input, ctx }) {
			const { scope, principal } = accessOf(ctx)
			const account = z.parse(webhookBindInput.shape.account, input['account'])
			const id = uuidv7()
			const secret = generateSecret()
			await tables().createBinding({
				id,
				webhook,
				scope: { type: scope.dimension, value: scope.value },
				account,
				secret,
				createdBy: principal,
				createdAt: Date.now(),
			})
			return { id, url: joinPath(path, id), secret }
		},
		async unbind({ input, ctx }) {
			const { scope } = accessOf(ctx)
			const id = z.parse(webhookUnbindInput.shape.id, input['id'])
			if (!(await tables().removeBinding(webhook, id, { type: scope.dimension, value: scope.value }))) {
				throw new NotFoundError('Not found')
			}
			return { id }
		},
	}
}
