// The Certificate Manager calls the AWS provider makes, over the JSON protocol (`json.ts`): request a public
// certificate for one host, validated by a DNS record the operator adds, and read it back (its status, the record to
// add, what uses it). A namespace proxy's hosts are served on the installation's HTTPS listener with these
// certificates.
//
// - Two calls only, and neither writes a tag or deletes: no grant of Control's role may rest on a tag Control could
//   write, and ACM has no condition that holds a tag write to the request that creates the certificate. A certificate
//   no host needs any more is the operator's to delete (the namespace's presentation names it).
// - `requestCertificate` sends an idempotency token, so a lost answer repeated within ACM's hour answers the same
//   certificate.
// - `describeCertificate` answers `null` only for `ResourceNotFoundException`. The validation record may be absent
//   for a moment after a request; it is `null` then, never a guess. A record is shown to an operator, so its name and
//   value must be DNS names of the form ACM gives.
// - A status ACM may add later is `invalid_answer`, never a guess.
// - The operator's command alone (`acmPlatformCertificates`) also lists the account's certificates, to find one it
//   requested for an installation's host on an earlier run. Control's client has no listing.
//
// UNVERIFIED: the operations' input and answer fields, the statuses, the token's form and its hour, and
// `ListCertificates`' summary fields (`Type`, `CreatedAt`, the alternative names) follow ACM's API reference; none was
// checked against an account.

import { z } from 'zod'
import { AwsError, type AwsJsonClient, awsJsonClient, type AwsJsonClientOptions, type AwsJsonService } from './json'

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
	/** The record the operator adds, and keeps: ACM's renewal uses it. `null` until ACM names it. */
	readonly validation: CertificateValidationRecord | null
	/** What uses it (a listener's ARN, the balancer's): a certificate in use cannot be deleted. */
	readonly inUseBy: readonly string[]
}

export interface AcmClient {
	/** Requests a public certificate for `host`, validated by DNS; answers its ARN. A repeat of `token` within ACM's hour answers the same one. */
	requestCertificate(input: { readonly host: string; readonly token: string }, signal?: AbortSignal): Promise<string>
	/** The certificate `arn`, or `null` when ACM answers there is none. */
	describeCertificate(arn: string, signal?: AbortSignal): Promise<Certificate | null>
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
			const requested = await json.call(
				'RequestCertificate',
				// No tags: a tag here would need `acm:AddTagsToCertificate`, which ACM cannot hold to this request alone.
				{ DomainName: input.host, ValidationMethod: 'DNS', IdempotencyToken: input.token },
				requestedSchema,
				signal,
			)
			return requested.CertificateArn
		},

		describeCertificate: (arn, signal) => describe(json, arn, signal),
	}
}

/** A certificate the account holds for exactly one host, as `ListCertificates` summarizes it. */
export interface CertificateSummary {
	readonly arn: string
	readonly host: string
	readonly status: 'PENDING_VALIDATION' | 'ISSUED'
	/** Seconds since the epoch. */
	readonly createdAt: number
}

/** The operator's command's own certificates: Control's two calls, and finding what the account already holds. */
export interface AcmPlatformCertificates extends AcmClient {
	/**
	 * The certificates ACM issued, or will issue once validated, for exactly `host`: no other name beside it, none
	 * imported or private. Newest first.
	 */
	findCertificates(host: string, signal?: AbortSignal): Promise<readonly CertificateSummary[]>
}

const listedSchema = z.object({
	CertificateSummaryList: z
		.array(z.object({
			CertificateArn: z.string(),
			DomainName: z.string(),
			SubjectAlternativeNameSummaries: z.array(z.string()).optional(),
			HasAdditionalSubjectAlternativeNames: z.boolean().optional(),
			Status: z.string().optional(),
			Type: z.string().optional(),
			CreatedAt: z.number().optional(),
		}))
		.optional(),
	NextToken: z.string().optional(),
})
/** Pages one listing reads before it refuses: a thousand certificates a page. */
const MAX_PAGES = 20

/**
 * The installation's own certificates (`installation/certificates.ts`), from the operator's credentials: `ListCertificates`
 * on top of Control's two calls. Control never builds this; its role is granted no listing.
 */
export function acmPlatformCertificates(options: AwsJsonClientOptions): AcmPlatformCertificates {
	const json = awsJsonClient(ACM, options)
	return {
		...acmClient(options),
		async findCertificates(host, signal) {
			if (!CERTIFICATE_HOST.test(host)) refuse('the host')
			const found: CertificateSummary[] = []
			let next: string | undefined
			for (let page = 0; page < MAX_PAGES; page++) {
				const listed = await json.call(
					'ListCertificates',
					{ CertificateStatuses: ['PENDING_VALIDATION', 'ISSUED'], MaxItems: 1000, ...(next === undefined ? {} : { NextToken: next }) },
					listedSchema,
					signal,
				)
				for (const summary of listed.CertificateSummaryList ?? []) {
					const names = summary.SubjectAlternativeNameSummaries ?? [summary.DomainName]
					const onlyHost = summary.DomainName === host && summary.HasAdditionalSubjectAlternativeNames !== true
						&& names.every((name) => name === host)
					const status = summary.Status
					if (!onlyHost || summary.Type !== 'AMAZON_ISSUED' || !CERTIFICATE_ARN.test(summary.CertificateArn)) continue
					if (status !== 'PENDING_VALIDATION' && status !== 'ISSUED') continue
					found.push({ arn: summary.CertificateArn, host, status, createdAt: summary.CreatedAt ?? 0 })
				}
				next = listed.NextToken
				if (next === undefined) return found.sort((a, b) => b.createdAt - a.createdAt)
			}
			throw new Error(`Certificate Manager: the account lists more than ${MAX_PAGES} pages of certificates`)
		},
	}
}

/** `DescribeCertificate`: `null` only when ACM answers there is none; an answer of another form is no answer. */
async function describe(json: AwsJsonClient, arn: string, signal?: AbortSignal): Promise<Certificate | null> {
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
	return {
		arn,
		host: certificate.DomainName,
		status: isStatus(certificate.Status) ? certificate.Status : invalid(),
		validation: record === undefined ? null : { name: record.Name, value: record.Value },
		inUseBy: certificate.InUseBy ?? [],
	}
}
