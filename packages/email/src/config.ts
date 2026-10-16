// The installation's mail transport as environment variables: `FABRIKA_EMAIL_PROVIDER` picks a provider from the
// registry the composition hands in, and each provider declares and parses its own variables. Every refusal names
// variables and never a value, because most of them are credentials.

import { z } from 'zod'
import { EmailDeliveryError, type EmailFetch, type EmailSender } from './email.js'
import { isValidEmailDisplayName, parseEmailFrom } from './validation.js'

export type EmailEnvironment = Readonly<Record<string, string | undefined>>

export interface EmailSenderIdentity {
	readonly address: string
	readonly name?: string
}

export interface EmailProviderVariable {
	readonly name: string
	readonly secret: boolean
	readonly required: boolean
}

export interface EmailProvider {
	/** Provider-specific variables, beside FABRIKA_EMAIL_PROVIDER/FROM/FROM_NAME. */
	readonly variables: readonly EmailProviderVariable[]
	/** Parses its own variables; throws `invalid_configuration` naming the variable, never its value. */
	create(input: { readonly from: EmailSenderIdentity; readonly env: EmailEnvironment; readonly fetch?: EmailFetch }): EmailSender
}

export type EmailProviderRegistry = Readonly<Record<string, EmailProvider>>

export type EmailTransportConfig =
	| { readonly kind: 'none' }
	| { readonly kind: 'provider'; readonly provider: string; readonly from: EmailSenderIdentity; readonly variables: readonly EmailProviderVariable[] }

/** The variable that selects the provider. */
export const EMAIL_PROVIDER_VARIABLE = 'FABRIKA_EMAIL_PROVIDER'
/** `FABRIKA_EMAIL_PROVIDER=none`: the installation states it has no transport, which an absent variable does not. */
export const NO_EMAIL_PROVIDER = 'none'
const FROM_VARIABLE = 'FABRIKA_EMAIL_FROM'
const FROM_NAME_VARIABLE = 'FABRIKA_EMAIL_FROM_NAME'
const EMAIL_VARIABLE_PREFIX = 'FABRIKA_EMAIL_'
const UNSET_SENDER: EmailSenderIdentity = { address: 'unset@example.invalid' }

const senderSchema = z.string().transform((value, context): EmailSenderIdentity => {
	const identity = parseEmailFrom(value)
	if (identity === null) {
		context.addIssue({ code: z.ZodIssueCode.custom })
		return z.NEVER
	}
	return identity
})
const displayNameSchema = z.string().refine(isValidEmailDisplayName)

interface Transport {
	readonly config: EmailTransportConfig
	readonly sender: EmailSender | null
}

interface ConfigurationProblem {
	/** The variable the problem names; empty when a provider's refusal names none. */
	readonly variable: string
	readonly text: string
}

/** An `invalid_configuration` that keeps its problems apart, so `readTransport` can merge a provider's into its own. */
class EmailConfigurationError extends EmailDeliveryError {
	readonly problems: readonly ConfigurationProblem[]

	constructor(problems: readonly ConfigurationProblem[]) {
		super(`Email configuration is invalid: ${problems.map((problem) => problem.text).join('; ')}`, { code: 'invalid_configuration' })
		this.problems = problems
	}
}

/** Throws one `invalid_configuration` listing every missing or invalid variable name. */
export function readEmailTransportConfig(env: EmailEnvironment, registry: EmailProviderRegistry): EmailTransportConfig {
	return readTransport(env, registry, undefined).config
}

/** null for `none` or an absent provider. */
export function emailSenderFromEnv(
	env: EmailEnvironment,
	registry: EmailProviderRegistry,
	options: { readonly fetch?: EmailFetch } = {},
): EmailSender | null {
	return readTransport(env, registry, options.fetch).sender
}

/** The non-empty string `FABRIKA_EMAIL_*` entries of any binding object (Worker bindings, process.env). */
export function pickEmailEnvironment(source: object): EmailEnvironment {
	const entries: [string, unknown][] = Object.entries(source)
	const picked: Record<string, string> = {}
	for (const [name, value] of entries) {
		if (name.startsWith(EMAIL_VARIABLE_PREFIX) && typeof value === 'string' && value !== '') picked[name] = value
	}
	return picked
}

/**
 * A provider's own variables through its schema. A failure is one `invalid_configuration` naming each offending
 * variable and never its value, in the form `readEmailTransportConfig` merges into its own refusal.
 */
export function parseProviderVariables<Schema extends z.ZodTypeAny>(schema: Schema, env: EmailEnvironment): z.output<Schema> {
	const parsed = schema.safeParse(env)
	if (parsed.success) return parsed.data
	const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')))]
	throw new EmailConfigurationError(names.map((name) => ({ variable: name, text: `${name || 'a variable'} is missing or invalid` })))
}

function readTransport(env: EmailEnvironment, registry: EmailProviderRegistry, fetch: EmailFetch | undefined): Transport {
	const providerName = presentValue(env[EMAIL_PROVIDER_VARIABLE])
	if (providerName === undefined || providerName === NO_EMAIL_PROVIDER) return { config: { kind: 'none' }, sender: null }
	const provider = Object.hasOwn(registry, providerName) ? registry[providerName] : undefined
	if (provider === undefined) {
		throw new EmailDeliveryError(`${EMAIL_PROVIDER_VARIABLE} must be none or one of: ${Object.keys(registry).join(', ')}`, {
			code: 'invalid_configuration',
		})
	}

	const problems: ConfigurationProblem[] = []
	const problem = (variable: string, text: string): void => {
		problems.push({ variable, text: `${variable} ${text}` })
	}
	const fromValue = presentValue(env[FROM_VARIABLE])
	const parsedFrom = fromValue === undefined ? undefined : senderSchema.safeParse(fromValue).data
	if (fromValue === undefined) problem(FROM_VARIABLE, 'is missing')
	else if (parsedFrom === undefined) problem(FROM_VARIABLE, 'is invalid')
	const fromName = presentValue(env[FROM_NAME_VARIABLE])
	if (fromName !== undefined && !displayNameSchema.safeParse(fromName).success) problem(FROM_NAME_VARIABLE, 'is invalid')
	else if (fromName !== undefined && parsedFrom?.name !== undefined) {
		problem(FROM_NAME_VARIABLE, `is refused because ${FROM_VARIABLE} already carries a display name`)
	}
	for (const variable of provider.variables) {
		if (variable.required && presentValue(env[variable.name]) === undefined) problem(variable.name, 'is missing')
	}
	const from = parsedFrom === undefined || fromName === undefined || parsedFrom.name !== undefined
		? parsedFrom
		: { address: parsedFrom.address, name: fromName }

	// The provider checks its own values; building it does no I/O. Without a usable sender a stand-in identity still
	// lets it report its variables, and that sender is never returned.
	let sender: EmailSender | null = null
	try {
		sender = provider.create({ from: from ?? UNSET_SENDER, env, fetch })
	} catch (error) {
		problems.push(...providerProblems(error, problems))
	}
	if (from === undefined || sender === null || problems.length > 0) throw new EmailConfigurationError(problems)

	return { config: { kind: 'provider', provider: providerName, from, variables: provider.variables }, sender }
}

/** A provider's refusal as problems, without those for a variable already reported. */
function providerProblems(error: unknown, reported: readonly ConfigurationProblem[]): ConfigurationProblem[] {
	if (error instanceof EmailConfigurationError) {
		return error.problems.filter((candidate) => !reported.some((problem) => problem.variable !== '' && problem.variable === candidate.variable))
	}
	// An error message is a fixed string by the `EmailDeliveryError` contract, so it may join the refusal.
	if (error instanceof EmailDeliveryError && error.code === 'invalid_configuration') return [{ variable: '', text: error.message }]
	throw error
}

/** Deploy tooling (GitHub Actions among it) passes an unset variable as an empty string, so empty means absent. */
function presentValue(value: string | undefined): string | undefined {
	return value === undefined || value === '' ? undefined : value
}
