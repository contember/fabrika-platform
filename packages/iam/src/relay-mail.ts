// IAM's mail through Control's relay, and the one case it falls back to its own provider: the relay answered that it did
// not take the message. Both compositions use it, so the Worker and the Bun process fall back alike.

import { EmailDeliveryError, type EmailSender } from '@fabrika/email'
import { logWarn } from './log'
import type { AuditEventInput } from './repositories/audit'

/**
 * Whether the relay refused the message for good, so nothing was recorded and the provider cannot have it:
 * - `provider_unauthorized`: Control knows no such key (a Control that holds an older secret, or none);
 * - `mail_not_configured`: Control has no transport of its own;
 * - a 404: Control runs no relay (an older release, or a Worker without its queue and bucket);
 * - `invalid_configuration`: IAM's own relay settings cannot reach it.
 * A timeout, a network failure or a provider outage may have reached the relay, so they never fall back.
 */
export function relayRefused(error: unknown): error is EmailDeliveryError {
	if (!(error instanceof EmailDeliveryError)) return false
	return error.code === 'provider_unauthorized' || error.code === 'mail_not_configured' || error.code === 'invalid_configuration'
		|| error.httpStatus === 404
}

/**
 * Sends through `relay`, and through `direct` (IAM's own provider) only when the relay refused the message for good
 * (`relayRefused`). The relay's capabilities are the sender's: a message goes there first. Without that fallback, sign-in
 * links would stop while IAM deploys ahead of Control, or between a rotated secret reaching IAM and reaching Control.
 *
 * A fallback that lasts past a rollout means the relay is misconfigured, and the gate and the console's Mail page no
 * longer see IAM's mail, so each one is `recorded` where an operator looks (the audit log), not only in the Worker's log.
 * A record that fails never stops the message.
 */
export function relayWithFallback(relay: EmailSender, direct: EmailSender, recorded: (refusal: EmailDeliveryError) => Promise<void>): EmailSender {
	return {
		capabilities: relay.capabilities,
		async send(message, signal) {
			try {
				return await relay.send(message, signal)
			} catch (error) {
				if (!relayRefused(error)) throw error
				logWarn("iam mail: Control's relay refused the message, so IAM sends it with its own provider", error)
				await recorded(error).catch((cause: unknown) => logWarn('iam mail: the relay fallback was not recorded', cause))
				return direct.send(message, signal)
			}
		},
	}
}

/** The audit record of one fallback: which refusal, never the message, its recipient or a key. */
export function relayFallbackEvent(requestId: string, refusal: EmailDeliveryError): AuditEventInput {
	return {
		requestId,
		principalId: null,
		principalLabel: 'mail-relay',
		app: 'propustka',
		action: 'iam.mail.relay_fallback',
		resourceType: 'mail',
		metadata: { code: refusal.code, ...(refusal.httpStatus === undefined ? {} : { httpStatus: refusal.httpStatus }) },
	}
}
