import type { AnyAppConfig, CloudflareAppConfig, ZeropsAppConfig } from './types'

/**
 * Authoring entry point for a fabrika app. Identity function: it returns the config unchanged so
 * the call site keeps full inference, while pinning the type and doing the minimal runtime
 * validation that must hold for ANY downstream step (the `id` is the control plane's primary key).
 *
 * The rest of the config is validated lazily by the deploy engine (M1), not here — `defineApp`
 * is meant to be cheap and importable from anywhere (CLI, worker, tests).
 *
 * OVERLOADED per target arm rather than typed as the union, for two reasons: the return type stays the
 * PRECISE arm (so `export default defineApp({ id, resources })` is still assignable to `AppConfig`), and
 * each overload contextually types the literal, which keeps excess-property checking — a typo'd field
 * name in a config is a compile error, not a silently ignored key. A generic `<T extends AnyAppConfig>`
 * would infer just as well but loses that check, which is the whole reason this is not one.
 *
 * ORDER MATTERS, and not decoratively: the FIRST overload supplies the contextual type used to infer the
 * argument, so with the Cloudflare arm first a Zerops literal is inferred against `target?: undefined`,
 * its `type: 'alpine/bun@1.3'` widens to `string`, and BOTH overloads then fail. Zerops goes first because
 * its arm is the one carrying literal-union fields. `src/__tests__/target.test.ts` pins this.
 */
export function defineApp(config: ZeropsAppConfig): ZeropsAppConfig
export function defineApp(config: CloudflareAppConfig): CloudflareAppConfig
export function defineApp(config: AnyAppConfig): AnyAppConfig {
	if (typeof config.id !== 'string' || config.id.trim() === '') {
		throw new Error('defineApp: `id` is required and must be a non-empty string')
	}
	return config
}
