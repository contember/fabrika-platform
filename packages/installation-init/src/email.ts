// The installation's mail transport as both installers take it: the provider, the sender and the display name from a
// flag or the variable beside it, and each provider variable from the environment only, under its own name, because an
// open provider registry cannot have one flag per variable and most of them are credentials.

import { type EmailEnvironment, type EmailProviderRegistry, readEmailTransportConfig } from '@fabrika/email'
import { type CommandEnv, readEnv, readFlag, requiredSetting, setting } from './options'

export type InstallationEmail =
	| { readonly kind: 'none' }
	| { readonly kind: 'provider'; readonly variables: ReadonlyMap<string, string>; readonly secretNames: ReadonlySet<string> }

export const EMAIL_FLAGS = ['--email-provider', '--email-from', '--email-from-name'] as const

const PROVIDER_VARIABLE = 'FABRIKA_EMAIL_PROVIDER'
const FROM_VARIABLE = 'FABRIKA_EMAIL_FROM'
const FROM_NAME_VARIABLE = 'FABRIKA_EMAIL_FROM_NAME'

/** Throws naming flags and variables, never a value. */
export function readInstallationEmail(
	argv: readonly string[],
	env: CommandEnv,
	options: { readonly registry: EmailProviderRegistry; readonly required: boolean },
): InstallationEmail {
	const given = setting(argv, env, '--email-provider', PROVIDER_VARIABLE)
	const provider = options.required ? requiredSetting(given, '--email-provider', PROVIDER_VARIABLE) : given
	if (provider === undefined || provider === 'none') {
		const refused = ['--email-from', '--email-from-name'].find((flag) => readFlag(argv, flag) !== undefined)
		if (refused !== undefined) throw new Error(`${refused} was given, but the email provider is none`)
		return { kind: 'none' }
	}

	const variables = new Map<string, string>([[PROVIDER_VARIABLE, provider]])
	const secretNames = new Set<string>()
	const collect = (name: string, value: string | undefined): void => {
		if (value !== undefined) variables.set(name, value)
	}
	collect(FROM_VARIABLE, setting(argv, env, '--email-from', FROM_VARIABLE))
	collect(FROM_NAME_VARIABLE, setting(argv, env, '--email-from-name', FROM_NAME_VARIABLE))
	const declared = Object.hasOwn(options.registry, provider) ? options.registry[provider]?.variables ?? [] : []
	for (const variable of declared) {
		const value = readEnv(env, variable.name)
		collect(variable.name, value)
		if (value !== undefined && variable.secret) secretNames.add(variable.name)
	}

	const collected: EmailEnvironment = Object.fromEntries(variables)
	readEmailTransportConfig(collected, options.registry)
	return { kind: 'provider', variables, secretNames }
}
