// Managed credentials written to an application Worker without a deploy (`ControlProvider.managedCredentials`): the
// version the environment runs, with the named secrets replaced and every other binding inherited, as
// `wrangler secret bulk` writes them. Cloudflare deploys that version at once; the application's object takes it up when
// it restarts on it. The values and the account token are secrets: never log one, nor an error object that holds them.

import type { ProviderManagedCredentialsInput } from '@fabrika/provider-contract'
import { z } from 'zod'
import { isWorkerName } from './runner-protocol'

const CF_API = 'https://api.cloudflare.com/client/v4'

/** The one request shape this module sends; the global `fetch` in production, a fake in tests. */
export type CloudflareApiFetch = (url: string, init: RequestInit) => Promise<Response>

export interface WorkerSecretsOptions {
	readonly accountId: string
	readonly apiToken: string
	readonly fetch: CloudflareApiFetch
}

/** The binding the platform's proxy Worker reaches its application Worker through (`createCloudflareProxyWorker`). */
const APPLICATION_BINDING = 'APP'

const envelopeSchema = z.object({
	success: z.boolean(),
	result: z.unknown(),
	errors: z.array(z.object({ code: z.number().optional(), message: z.string() }).passthrough()).optional(),
})
const bindingSchema = z.object({ type: z.string(), name: z.string() }).passthrough()
const settingsSchema = z.object({ bindings: z.array(bindingSchema) }).passthrough()
const serviceBindingSchema = z.object({ type: z.literal('service'), name: z.string(), service: z.string() }).passthrough()

/** The remote name of the platform's proxy Worker of an application environment. */
export const proxyScriptName = (appId: string, env: string): string => `${env}-${appId}-proxy`

/**
 * Write `values` as secrets of the environment's application Worker, in one new version. The Worker is the one its
 * platform proxy binds as `APP`, and only a name of the environment's own (`<env>-<app>` or below it) is written to.
 */
export async function writeApplicationSecrets(options: WorkerSecretsOptions, input: ProviderManagedCredentialsInput): Promise<void> {
	const { environment, values, signal } = input
	if (environment.kind === 'dev') throw new Error('Cloudflare runs no dev environment (ADR-0049)')
	const names = Object.keys(values)
	if (names.length === 0) return
	const own = `${environment.env}-${environment.appId}`
	const proxy = proxyScriptName(environment.appId, environment.env)
	const proxySettings = await readSettings(options, proxy, signal)
	const application = proxySettings.bindings
		.map((binding) => serviceBindingSchema.safeParse(binding))
		.flatMap((parsed) => parsed.success && parsed.data.name === APPLICATION_BINDING ? [parsed.data.service] : [])
	const script = application[0]
	if (application.length !== 1 || script === undefined) {
		throw new Error(`cloudflare: the proxy Worker ${proxy} binds no single application Worker as ${APPLICATION_BINDING}; deploy the environment`)
	}
	if (!isWorkerName(script) || script === proxy || (script !== own && !script.startsWith(`${own}-`))) {
		throw new Error(`cloudflare: the proxy Worker ${proxy} binds ${APPLICATION_BINDING} to a Worker outside ${own}; deploy the environment`)
	}
	const current = await readSettings(options, script, signal)
	// Every binding but the secrets written here is inherited from the version that runs, by its type and name.
	const inherited = current.bindings
		.filter((binding) => !(binding.type === 'secret_text' && Object.hasOwn(values, binding.name)))
		.map((binding) => ({ type: binding.type, name: binding.name }))
	const written = Object.entries(values).map(([name, text]) => ({ type: 'secret_text', name, text }))
	const body = new FormData()
	body.set('settings', JSON.stringify({ bindings: [...inherited, ...written] }))
	await cloudflareResult(options, `writing the secrets ${names.join(', ')} of ${script}`, settingsUrl(options, script), {
		method: 'PATCH',
		body,
		signal,
	})
}

const settingsUrl = (options: WorkerSecretsOptions, script: string): string =>
	`${CF_API}/accounts/${encodeURIComponent(options.accountId)}/workers/scripts/${encodeURIComponent(script)}/settings`

async function readSettings(options: WorkerSecretsOptions, script: string, signal: AbortSignal): Promise<z.infer<typeof settingsSchema>> {
	const result = await cloudflareResult(options, `reading the settings of ${script}`, settingsUrl(options, script), { method: 'GET', signal })
	const settings = settingsSchema.safeParse(result)
	if (!settings.success) throw new Error(`cloudflare: reading the settings of ${script}: unexpected response`)
	return settings.data
}

/** One API call with the account token, no redirect followed; the envelope's `result`, or a refusal naming `what`. */
async function cloudflareResult(
	options: WorkerSecretsOptions,
	what: string,
	url: string,
	init: { readonly method: string; readonly body?: FormData; readonly signal: AbortSignal },
): Promise<unknown> {
	const response = await options.fetch(url, {
		method: init.method,
		headers: { authorization: `Bearer ${options.apiToken}` },
		...(init.body === undefined ? {} : { body: init.body }),
		redirect: 'manual',
		signal: init.signal,
	})
	const parsed = envelopeSchema.safeParse(await response.json().catch(() => null))
	if (!parsed.success) throw new Error(`cloudflare: ${what}: unexpected response (HTTP ${response.status})`)
	if (!response.ok || !parsed.data.success) {
		const first = parsed.data.errors?.[0]
		const reason = first === undefined ? `HTTP ${response.status}` : `${first.code === undefined ? '' : `${first.code} `}${first.message}`
		throw new Error(`cloudflare: ${what} failed: ${reason}`)
	}
	return parsed.data.result
}
