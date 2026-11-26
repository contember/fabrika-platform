// The Certificate Manager calls the AWS provider makes, over the JSON protocol (`json.ts`): request a public
// certificate for one host, validated by a DNS record the operator adds; read it back (its status and the record to
// add); delete one no host needs any more. A namespace proxy's hosts are served on the installation's HTTPS listener
// with these certificates.
//
// - `requestCertificate` sends an idempotency token, so a lost answer repeated within ACM's hour answers the same
//   certificate. Its tags name the namespace, so an operator can tell the certificates fabrika requested.
// - `describeCertificate` answers `null` only for `ResourceNotFoundException`. The validation record may be absent
//   for a moment after a request; it is `null` then, never a guess. A record is shown to an operator, so its name and
//   value must be DNS names of the form ACM gives.
// - `deleteCertificate` answers `false` when there was none. One still on a listener is refused by ACM
//   (`ResourceInUseException`), which is the caller's to read.
// - A status ACM may add later is `invalid_answer`, never a guess.
//
// UNVERIFIED: the operations' input and answer fields, the statuses, the token's form and its hour follow ACM's API
// reference; none was checked against an account.

import { z } from 'zod'
import { AwsError, awsJsonClient, type AwsJsonClientOptions, type AwsJsonService } from './json'

export const ACM: AwsJsonService = { service: 'acm', targetPrefix: 'CertificateManager', jsonVersion: '1.1' }

/** Every status a certificate can be in, as the tuple `z.enum` takes. */
export const CERTIFICATE_STATUS_ENUM: ['PENDING_VALIDATION', 'ISSUED', 'INACTIVE', 'EXPIRED', 'VALIDATION_TIMED_OUT', 'REVOKED', 'FAILED'] = [
	'PENDING_VALIDATION',
	'ISSUED',
	'INACTIVE',
	'EXPIRED',
	'VALIDATION_TIMED_OUT',
	'REVOKED',
	'FAILED',
]
export const CERTIFICATE_STATUSES: readonly CertificateStatus[] = CERTIFICATE_STATUS_ENUM
export type CertificateStatus = (typeof CERTIFICATE_STATUS_ENUM)[number]

/** A certificate's ARN. */
export const CERTIFICATE_ARN =
	/^arn:aws(?:-[a-z]{1,10}){0,2}:acm:[a-z0-9-]{1,32}:\d{12}:certificate\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A host a certificate is requested for: a lower-case DNS name of two labels or more, no wildcard. */
export const CERTIFICATE_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/** An idempotency token: what ACM takes, word characters, at most 32. */
const IDEMPOTENCY_TOKEN = /^\w{1,32}$/
/** A validation record's name or value: a fully qualified DNS name ACM gives (`_<hex>.<host>.`, `_<hex>.<…>.acm-validations.aws.`). */
export const RECORD_NAME = /^(?=.{1,255}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+$/
/** The most tags a request sends: ACM takes 50, the provider sends a few. */
const MAX_TAGS = 10
const TAG_KEY = /^[A-Za-z0-9_.:/=+@-]{1,128}$/
const TAG_VALUE = /^[A-Za-z0-9_.:/=+@ -]{0,256}$/

/** The DNS record that proves the host is the requester's: a `CNAME` of `name` to `value`. */
export interface CertificateValidationRecord {
	readonly name: string
	readonly value: string
}

/** A certificate read back. */
export interface Certificate {
	readonly arn: string
	readonly host: string
	readonly status: CertificateStatus
	/** The record the operator adds; `null` until ACM names it, and for a certificate that no longer needs one. */
	readonly validation: CertificateValidationRecord | null
	/** What uses it (a listener's ARN, the balancer's): a certificate in use cannot be deleted. */
	readonly inUseBy: readonly string[]
}

export interface AcmClient {
	/** Requests a public certificate for `host`, validated by DNS; answers its ARN. A repeat of `token` within ACM's hour answers the same one. */
	requestCertificate(
		input: { readonly host: string; readonly token: string; readonly tags: Readonly<Record<string, string>> },
		signal?: AbortSignal,
	): Promise<string>
	/** The certificate `arn`, or `null` when ACM answers there is none. */
	describeCertificate(arn: string, signal?: AbortSignal): Promise<Certificate | null>
	/** Deletes `arn`; answers `false` when there was none. One in use is refused by ACM. */
	deleteCertificate(arn: string, signal?: AbortSignal): Promise<boolean>
}

const requestedSchema = z.object({ CertificateArn: z.string().regex(CERTIFICATE_ARN) })
const describedSchema = z.object({
	Certificate: z.object({
		CertificateArn: z.string(),
		DomainName: z.string(),
		Status: z.string(),
		DomainValidationOptions: z
			.array(z.object({
				DomainName: z.string(),
				ResourceRecord: z.object({ Name: z.string(), Type: z.string(), Value: z.string() }).optional(),
			}))
			.optional(),
		InUseBy: z.array(z.string()).optional(),
	}),
})
const deletedSchema = z.object({})

const isStatus = (value: string): value is CertificateStatus => CERTIFICATE_STATUSES.some((status) => status === value)

/** Refuses an input this module cannot send before anything is sent, naming the argument only. */
function refuse(what: string): never {
	throw new Error(`Certificate Manager: ${what} is not one Certificate Manager takes`)
}

/** Certificate Manager at `options.origin`; the client is of the `ACM` service by construction. */
export function acmClient(options: AwsJsonClientOptions): AcmClient {
	const json = awsJsonClient(ACM, options)
	return {
		async requestCertificate(input, signal) {
			if (!CERTIFICATE_HOST.test(input.host)) refuse('the host')
			if (!IDEMPOTENCY_TOKEN.test(input.token)) refuse('the idempotency token')
			const tags = Object.entries(input.tags)
			if (tags.length > MAX_TAGS || !tags.every(([key, value]) => TAG_KEY.test(key) && TAG_VALUE.test(value))) refuse('the tags')
			const requested = await json.call(
				'RequestCertificate',
				{
					DomainName: input.host,
					ValidationMethod: 'DNS',
					IdempotencyToken: input.token,
					Tags: tags.map(([Key, Value]) => ({ Key, Value })),
				},
				requestedSchema,
				signal,
			)
			return requested.CertificateArn
		},

		async describeCertificate(arn, signal) {
			if (!CERTIFICATE_ARN.test(arn)) refuse('the certificate')
			let described: z.infer<typeof describedSchema>
			try {
				described = await json.call('DescribeCertificate', { CertificateArn: arn }, describedSchema, signal)
			} catch (error) {
				if (error instanceof AwsError && error.code === 'ResourceNotFoundException') return null
				throw error
			}
			const certificate = described.Certificate
			const invalid = (): never => {
				throw new AwsError('DescribeCertificate', 'invalid_answer', 200, null, false)
			}
			// An answer about another certificate, or one of another form, is no answer about this one.
			if (certificate.CertificateArn !== arn || !CERTIFICATE_HOST.test(certificate.DomainName) || !isStatus(certificate.Status)) invalid()
			const options = certificate.DomainValidationOptions ?? []
			// One host per certificate: a record for another is no record for this one.
			if (options.length > 1 || options.some((option) => option.DomainName !== certificate.DomainName)) invalid()
			const record = options[0]?.ResourceRecord
			if (record !== undefined && (record.Type !== 'CNAME' || !RECORD_NAME.test(record.Name) || !RECORD_NAME.test(record.Value))) invalid()
			const inUseBy = certificate.InUseBy ?? []
			return {
				arn,
				host: certificate.DomainName,
				status: isStatus(certificate.Status) ? certificate.Status : invalid(),
				validation: record === undefined ? null : { name: record.Name, value: record.Value },
				inUseBy,
			}
		},

		async deleteCertificate(arn, signal) {
			if (!CERTIFICATE_ARN.test(arn)) refuse('the certificate')
			try {
				await json.call('DeleteCertificate', { CertificateArn: arn }, deletedSchema, signal)
				return true
			} catch (error) {
				if (error instanceof AwsError && error.code === 'ResourceNotFoundException') return false
				throw error
			}
		},
	}
}
