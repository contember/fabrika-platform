import type { EmailProviderRegistry } from './config.js'
import { resendEmailProvider } from './resend.js'
import { smartEmailingEmailProvider } from './smartemailing.js'

/** The providers `FABRIKA_EMAIL_PROVIDER` can name in a stock installation. Memory and Directory are composition inputs. */
export const builtinEmailProviders = {
	resend: resendEmailProvider,
	smartemailing: smartEmailingEmailProvider,
} satisfies EmailProviderRegistry
