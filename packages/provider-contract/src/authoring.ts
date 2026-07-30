import type { AppSchema } from '@fabrika/auth-core'

export const APP_PROVIDER = Symbol.for('@fabrika/provider-contract/app-provider')

export interface ProviderAuthoredApp<Provider extends string = string> {
	readonly [APP_PROVIDER]: Provider
}

export const authoredAppProvider = (value: unknown): string | undefined => {
	if (typeof value !== 'object' || value === null) {
		return undefined
	}
	const provider = Reflect.get(value, APP_PROVIDER)
	return typeof provider === 'string' && provider !== '' ? provider : undefined
}

export const isProviderAuthoredApp = <Provider extends string>(
	value: unknown,
	provider: Provider,
): value is ProviderAuthoredApp<Provider> => authoredAppProvider(value) === provider

/** Provider-neutral build inputs and environment requirements declared by an app. */
export interface AppPipeline {
	/** Source directory relative to the app config file. Defaults to `.`. */
	workerDir?: string
	/** Shell command that builds the deployable artifact. */
	build?: string
	/** Secret names that must resolve before deployment. */
	secrets?: string[]
	/** Non-secret variable names that must resolve before deployment. */
	vars?: string[]
}

/** App metadata shared by every provider-specific authoring config. */
export interface AppConfigBase {
	/** Stable app id, unique within one control plane. */
	id: string
	/** The app-owned authorization vocabulary reconciled into IAM. */
	schema?: AppSchema
	/** Provider-neutral build and environment requirements. */
	pipeline?: AppPipeline
}
