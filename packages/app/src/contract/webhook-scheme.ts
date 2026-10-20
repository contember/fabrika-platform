// A webhook's verifier as data: `buildArtifact` refuses a scheme this parser refuses, and the artifact's parser reads
// it with the same schema, so a stored artifact never carries a verifier the runtime cannot run.

import { WEBHOOK_PRESETS, type WebhookScheme } from '@fabrika/auth-core'
import { z } from 'zod/v4'

/** An HTTP header name (RFC 9110's token). */
const headerName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/, 'is not a header name')

export const hmacSchemeSchema = z.strictObject({
	header: headerName,
	algorithm: z.enum(['sha1', 'sha256', 'sha512']),
	encoding: z.enum(['hex', 'base64']),
	prefix: z.string().min(1).max(32).optional(),
	timestamp: headerName.optional(),
	signed: z.enum(['body', 'timestamp.body']),
	id: headerName.optional(),
}).refine(
	// An unsigned timestamp proves nothing, and a signed one needs the header it is read from.
	(scheme) => (scheme.signed === 'timestamp.body') === (scheme.timestamp !== undefined),
	"signed: 'timestamp.body' names its timestamp header, and only it does",
)

export const webhookSchemeSchema: z.ZodType<WebhookScheme> = z.union([
	z.enum(WEBHOOK_PRESETS),
	z.strictObject({ hmac: hmacSchemeSchema }),
	z.strictObject({ basic: z.literal(true) }),
	z.strictObject({ bearer: z.literal(true) }),
])

export const WEBHOOK_SCHEME_ALLOWED =
	"scheme: 'github-sha256' | 'slack' | 'standard-webhooks' | 'stripe' | 'twilio' | { hmac: { header, algorithm: 'sha1' | 'sha256' | 'sha512', encoding: 'hex' | 'base64', prefix?, timestamp?, signed: 'body' | 'timestamp.body', id? } } | { basic: true } | { bearer: true }"
