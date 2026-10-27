// IAM's mail through Control's relay, and the one case it falls back to its own provider: the relay answered that it did
// not take the message. Both compositions use it, so the Worker and the Bun process fall back alike.

import { EmailDeliveryError, type EmailSender } from '@fabrika/email'
import { logWarn } from './log'

/**
 * Whether the relay refused the message for good, so nothing was recorded and the provider cannot have it:
 * - `provider_unauthorized`: Control knows no such key (a Control that holds an older secret, or none);
 * - `mail_not_configured`: Control has no transport of its own;
 * - a 404: Control runs no relay (an older release, or a Worker without its queue and bucket);
 * - `invalid_configuration`: IAM's own relay settings cannot reach it.
 * A timeout, a network failure or a provider outage may have reached the relay, so they never fall back.
 */
export function relayRefused(error: unknown): boolean {
	if (!(error instanceof EmailDeliveryError)) return false
	return error.code === 'provider_unauthorized' || error.code === 'mail_not_configured' || error.code === 'invalid_configuration'
		|| error.httpStatus === 404
}

/**
 * Sends through `relay`, and through `direct` (IAM's own provider) only when the relay refused the message for good
 * (`relayRefused`). The relay's capabilities are the sender's: a message goes there first. Without that fallback, sign-in
 * links would stop while IAM deploys ahead of Control, or between a rotated secret reaching IAM and reaching Control.
 */
export function relayWithFallback(relay: EmailSender, direct: EmailSender): EmailSender {
	return {
		capabilities: relay.capabilities,
		async send(message, signal) {
			try {
				return await relay.send(message, signal)
			} catch (error) {
				if (!relayRefused(error)) throw error
				logWarn("iam mail: Control's relay refused the message, so IAM sends it with its own provider", error)
				return direct.send(message, signal)
			}
		},
	}
}
