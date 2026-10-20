// What a procedure that declares `binds: '<webhook>'` reaches through `ctx.webhooks('<webhook>')`, and what it answers
// the member who binds: the binding's URL and its secret, shown once, or the provider's secret set afterwards.

import { z } from 'zod/v4'
import type { AppCapability, Ref } from '../implement/capability'

/** The output of a procedure that binds: the binding's id, the URL the provider posts to, and the secret, once. */
export const WebhookSecret = z.strictObject({ id: z.uuid(), url: z.string().min(1), secret: z.string().min(1) })

export type WebhookSecret = z.output<typeof WebhookSecret>

/**
 * The bindings of one webhook. A binding reaches the value the capability names: a `Ref` of the webhook's dimension, or
 * an `AppCapability` for a webhook bound to `'app'`. Both run in the procedure's transaction.
 */
export interface WebhookBindings {
	/** A new binding that accepts deliveries for `account`; the framework generates its secret. */
	bind(capability: Ref<string, string> | AppCapability<string>, account: string): Promise<WebhookSecret>
	/**
	 * Replaces the secret of the binding `id` of that value with one the provider issued (Stripe, Slack, Twilio): the
	 * provider shows it only after the binding's URL is registered. `false` when the value has no binding of that id.
	 */
	setSecret(capability: Ref<string, string> | AppCapability<string>, id: string, secret: string): Promise<boolean>
	/** Removes the binding `id` of that value; `false` when it has none of that id. */
	unbind(capability: Ref<string, string> | AppCapability<string>, id: string): Promise<boolean>
}
