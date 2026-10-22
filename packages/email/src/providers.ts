import { ahaSendEmailProvider } from './ahasend.js'
import type { EmailProviderRegistry, EmailProviderVariable } from './config.js'
import { lettermintEmailProvider } from './lettermint.js'
import { postmarkEmailProvider } from './postmark.js'
import { resendEmailProvider } from './resend.js'
import { smartEmailingEmailProvider } from './smartemailing.js'

/**
 * The providers `FABRIKA_EMAIL_PROVIDER` can name in a stock installation, sorted by name: the order every help text
 * and refusal lists them in. Memory and Directory are composition inputs.
 */
export const builtinEmailProviders = {
	ahasend: ahaSendEmailProvider,
	lettermint: lettermintEmailProvider,
	postmark: postmarkEmailProvider,
	resend: resendEmailProvider,
	smartemailing: smartEmailingEmailProvider,
} satisfies EmailProviderRegistry

/** Every built-in provider's own variables, in registry order: what the installers write and the workflow passes on. */
export const builtinEmailProviderVariables: readonly EmailProviderVariable[] = Object.values(builtinEmailProviders).flatMap((provider) =>
	provider.variables
)

/**
 * The first framework release whose registry holds each built-in provider. An application on an older release builds
 * its sender from its own registry, so it cannot be handed one it lacks; Control refuses that deploy. `null`: every
 * release that sends through the installation (`mailer: 'installation'`, from 0.5.0) holds it. A new provider names
 * the release after the newest one published without it.
 */
export const builtinEmailProviderSince = {
	ahasend: '0.8.2',
	lettermint: '0.8.2',
	postmark: '0.8.2',
	resend: null,
	smartemailing: null,
} as const satisfies Record<keyof typeof builtinEmailProviders, string | null>
