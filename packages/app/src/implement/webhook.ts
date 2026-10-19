// A webhook's bindings and deliveries (docs/reference/application-runtime.md). A procedure that declares `binds`
// creates a binding through `ctx.webhooks('<name>')`; a GitHub webhook bound to a dimension also has the generated
// `webhooks.<name>.bind` endpoint, for a holder of that dimension's `members.manage`. The framework generates the
// secret and keeps the binding in `fabrika_webhook_bindings`. A delivery is checked in a fixed order — the binding,
// the signature over the raw body, the account, the input, the delivery key — before its handler sees a `Ref` of the
// bound value, or its application-wide capabilities when the webhook is bound to `'app'`.

import type { ScopeBinding, WebhookScheme } from '@fabrika/auth-core'
import { type CapabilityAuthority, describeGrant } from '@fabrika/db/capability'
import type { Session, WebhookTables } from '@fabrika/db/framework'
import { uuidv7 } from '@fabrika/platform'
import { z } from 'zod/v4'
import { joinPath, WEBHOOK_ACCOUNT_PATTERN, WEBHOOK_SCOPE_FIELD } from '../contract/defaults'
import type { WebhookBindings, WebhookSecret } from '../contract/webhook-binding'
import { BadRequestError, NotFoundError } from '../errors'
import { CapabilityRefusedError, Ref } from './capability'

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

/**
 * A delivery key is kept this long per binding. GitHub signs no timestamp, so a body replayed after the window
 * runs again; GitHub itself redelivers for three days.
 */
export const WEBHOOK_REPLAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How long a delivery's claim outlasts its handler's time limit: a copy that arrives later finds the claim held and is
 * answered as received; once the lease passed without a completion (a crash, a lost connection), the redelivery runs.
 */
export const WEBHOOK_CLAIM_GRACE_MS = 30_000

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

/**
 * 32 random bytes, shown once to the member who binds: as hex, the key a provider signs with or sends as its password
 * or token; for Standard Webhooks, `whsec_` and the bytes in base64, as its senders expect.
 */
function generateSecret(scheme: WebhookScheme): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	if (scheme === 'standard-webhooks') {
		return `whsec_${btoa(String.fromCharCode(...bytes))}`
	}
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The scope a binding of a webhook bound to `'app'` records: the application, which has no value. */
export const APP_BINDING_SCOPE = Object.freeze({ type: 'app', value: '' })

/** The longest account a binding records for a provider other than GitHub. */
const MAX_ACCOUNT_LENGTH = 200

/** What a procedure that binds needs of its webhook: where deliveries arrive, how they are signed, what they reach. */
export interface BindableWebhook {
	readonly name: string
	readonly path: string
	readonly scheme: WebhookScheme
	readonly boundTo: ScopeBinding
}

/** Where `ctx.webhooks` runs: the procedure's transaction, bound to its request like every handle. */
export interface BindingSite {
	readonly site: string
	readonly webhook: BindableWebhook
	readonly tables: () => WebhookTables
	readonly authority: CapabilityAuthority
	readonly session: () => Promise<Session>
	readonly check: () => void
	/** Who binds: the caller's subject, recorded with the binding. */
	readonly principal: string
}

/** `ctx.webhooks` of a procedure that declares `binds`: only its declared webhook, only on the value its capability names. */
export function webhookBindings(site: BindingSite): (name: string) => WebhookBindings {
	const { webhook } = site
	const scopeOf = (capability: unknown): { readonly type: string; readonly value: string } => {
		site.check()
		const grant = site.authority.resolve(capability)
		if (webhook.boundTo.kind === 'app' && grant.kind === 'app') {
			return APP_BINDING_SCOPE
		}
		if (webhook.boundTo.kind === 'dimension' && grant.kind === 'ref' && grant.dimension === webhook.boundTo.dimension) {
			return { type: grant.dimension, value: grant.id }
		}
		const wanted = webhook.boundTo.kind === 'app' ? 'an app capability (ctx.app)' : `a Ref of ${webhook.boundTo.dimension}`
		throw new CapabilityRefusedError(
			'wrong_binding',
			`${site.site}: webhook '${webhook.name}' binds with ${wanted}, and it was handed ${describeGrant(grant)}`,
		)
	}
	const bindings: WebhookBindings = Object.freeze({
		async bind(capability: unknown, account: unknown): Promise<WebhookSecret> {
			const scope = scopeOf(capability)
			const recorded = accountOf(webhook.scheme, account)
			const id = uuidv7()
			const secret = generateSecret(webhook.scheme)
			await site.tables().createBinding(
				{ id, webhook: webhook.name, scope, account: recorded, secret, createdBy: site.principal, createdAt: Date.now() },
				await site.session(),
			)
			return { id, url: joinPath(webhook.path, id), secret }
		},
		async unbind(capability: unknown, id: unknown): Promise<boolean> {
			const scope = scopeOf(capability)
			if (typeof id !== 'string' || !z.uuid().safeParse(id).success) {
				return false
			}
			return await site.tables().removeBinding(webhook.name, id, scope, await site.session())
		},
	})
	return (name) => {
		if (name !== webhook.name) {
			throw new CapabilityRefusedError('undeclared_binding', `${site.site} does not declare binds: '${String(name)}'`)
		}
		return bindings
	}
}

/** The account a binding records: GitHub's `installation:<id>` or `repository:<id>`, another provider's own label. */
function accountOf(scheme: WebhookScheme, account: unknown): string {
	if (scheme === 'github-sha256') {
		const parsed = webhookBindInput.shape.account.safeParse(account)
		if (!parsed.success) {
			throw new BadRequestError("A GitHub binding's account is installation:<id> or repository:<id>")
		}
		return parsed.data
	}
	const printable = (text: string) => [...text].every((char) => char >= ' ' && char !== '\u007f')
	if (typeof account !== 'string' || account === '' || account.length > MAX_ACCOUNT_LENGTH || !printable(account)) {
		throw new BadRequestError(`A binding's account is a text of 1 to ${MAX_ACCOUNT_LENGTH} printable characters`)
	}
	return account
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
			const secret = generateSecret('github-sha256')
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
