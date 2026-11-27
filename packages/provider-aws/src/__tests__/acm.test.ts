// The Certificate Manager client against the fake endpoint: a certificate requested for one host by DNS under an
// idempotency token and with no tags, read back with its validation record; no call that tags or deletes; an answer of
// another form is refused, and an input of another form is refused before anything is sent.

import { describe, expect, test } from 'bun:test'
import { ACM, acmClient, acmPlatformCertificates } from '../aws/acm'
import { awsError, fakeAws } from './helpers/fake-aws'

const ARN = 'arn:aws:acm:eu-central-1:123456789012:certificate/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'
const HOST = 'notes.example.com'
const RECORD = { Name: '_3f2a9c.notes.example.com.', Type: 'CNAME', Value: '_7b1d.abcdefgh.acm-validations.aws.' }

const described = (change: Record<string, unknown> = {}) => ({
	Certificate: {
		CertificateArn: ARN,
		DomainName: HOST,
		Status: 'PENDING_VALIDATION',
		SubjectAlternativeNames: [HOST],
		Type: 'AMAZON_ISSUED',
		DomainValidationOptions: [{ DomainName: HOST, ValidationStatus: 'PENDING_VALIDATION', ResourceRecord: RECORD }],
		...change,
	},
})

describe('acmClient', () => {
	test('requests a certificate for one host, validated by DNS, under its idempotency token and with no tags', async () => {
		const { options, calls } = fakeAws(ACM, { RequestCertificate: () => ({ CertificateArn: ARN }) })
		expect(await acmClient(options).requestCertificate({ host: HOST, token: 'a1b2c3' })).toBe(ARN)
		// No tags: a tag would need a grant ACM cannot hold to the request that creates the certificate.
		expect(calls).toEqual([{
			operation: 'RequestCertificate',
			target: 'CertificateManager.RequestCertificate',
			body: { DomainName: HOST, ValidationMethod: 'DNS', IdempotencyToken: 'a1b2c3' },
		}])
	})

	test('the client neither tags nor deletes a certificate', () => {
		expect(Object.keys(acmClient(fakeAws(ACM, {}).options)).sort()).toEqual(['describeCertificate', 'requestCertificate'])
	})

	test('reads a certificate back with its status, its validation record and what uses it', async () => {
		const pending = fakeAws(ACM, { DescribeCertificate: () => described() })
		expect(await acmClient(pending.options).describeCertificate(ARN)).toEqual({
			arn: ARN,
			host: HOST,
			status: 'PENDING_VALIDATION',
			validation: { name: RECORD.Name, value: RECORD.Value },
			inUseBy: [],
		})
		expect(pending.calls[0]?.body).toEqual({ CertificateArn: ARN })
		// Just requested: ACM names no record yet.
		const fresh = fakeAws(ACM, { DescribeCertificate: () => described({ DomainValidationOptions: [{ DomainName: HOST }] }) })
		expect((await acmClient(fresh.options).describeCertificate(ARN))?.validation).toBeNull()
		const listener = 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:loadbalancer/app/fabrika/0123456789abcdef'
		const issued = fakeAws(ACM, { DescribeCertificate: () => described({ Status: 'ISSUED', InUseBy: [listener] }) })
		expect(await acmClient(issued.options).describeCertificate(ARN)).toMatchObject({ status: 'ISSUED', inUseBy: [listener] })
		const gone = fakeAws(ACM, { DescribeCertificate: () => awsError('ResourceNotFoundException') })
		expect(await acmClient(gone.options).describeCertificate(ARN)).toBeNull()
		const denied = fakeAws(ACM, { DescribeCertificate: () => awsError('AccessDeniedException') })
		await expect(acmClient(denied.options).describeCertificate(ARN)).rejects.toMatchObject({ code: 'AccessDeniedException' })
	})

	test('an answer about another certificate, of an unknown status or with a record of another form is an invalid answer', async () => {
		for (
			const change of [
				{ CertificateArn: ARN.replace('0f1e', '1f1e') },
				{ Status: 'SOMETHING_NEW' },
				{ DomainName: 'other.example.com' },
				{ DomainValidationOptions: [{ DomainName: HOST, ResourceRecord: { ...RECORD, Type: 'TXT' } }] },
				{ DomainValidationOptions: [{ DomainName: HOST, ResourceRecord: { ...RECORD, Value: 'evil value <script>' } }] },
				{ DomainValidationOptions: [{ DomainName: 'other.example.com', ResourceRecord: RECORD }] },
				{ DomainValidationOptions: [{ DomainName: HOST, ResourceRecord: RECORD }, { DomainName: HOST, ResourceRecord: RECORD }] },
				// Another name beside the host, a wildcard, or no names said: never exactly one host.
				{ SubjectAlternativeNames: [HOST, 'control.example.com'] },
				{ SubjectAlternativeNames: ['*.example.com'] },
				{ SubjectAlternativeNames: undefined },
				// Imported or private: no validation options say what it covers, and nothing here requested it.
				{ Type: 'IMPORTED', SubjectAlternativeNames: [HOST, 'control.example.com'], DomainValidationOptions: undefined, Status: 'ISSUED' },
				{ Type: 'IMPORTED', DomainValidationOptions: undefined, Status: 'ISSUED' },
				{ Type: 'PRIVATE', DomainValidationOptions: undefined, Status: 'ISSUED' },
				{ Type: undefined },
			]
		) {
			const { options } = fakeAws(ACM, { DescribeCertificate: () => described(change) })
			await expect(acmClient(options).describeCertificate(ARN)).rejects.toMatchObject({ code: 'invalid_answer' })
		}
	})

	test('refuses an input of another form before anything is sent', async () => {
		const { options, calls } = fakeAws(ACM, {})
		const acm = acmClient(options)
		for (const host of ['*.example.com', 'Notes.example.com', 'localhost', 'notes.example.com.', `${'a'.repeat(64)}.example.com`]) {
			await expect(acm.requestCertificate({ host, token: 'a1' })).rejects.toThrow('the host')
		}
		await expect(acm.requestCertificate({ host: HOST, token: 'not-a-word' })).rejects.toThrow('the idempotency token')
		await expect(acm.requestCertificate({ host: HOST, token: 'a'.repeat(33) })).rejects.toThrow('the idempotency token')
		await expect(acm.describeCertificate('arn:aws:s3:::bucket')).rejects.toThrow('the certificate')
		expect(calls).toEqual([])
	})
})

describe('acmPlatformCertificates', () => {
	const arn = (n: number) => `arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
	const summary = (n: number, change: Record<string, unknown> = {}) => ({
		CertificateArn: arn(n),
		DomainName: HOST,
		SubjectAlternativeNameSummaries: [HOST],
		HasAdditionalSubjectAlternativeNames: false,
		Status: 'ISSUED',
		Type: 'AMAZON_ISSUED',
		CreatedAt: 1_700_000_000 + n,
		...change,
	})

	test("finds the account's certificates for exactly the host across pages, issued first; one naming more, imported or private is none", async () => {
		const { options, calls } = fakeAws(ACM, {
			ListCertificates: (body) =>
				typeof body === 'object' && body !== null && 'NextToken' in body
					? { CertificateSummaryList: [summary(4, { Status: 'PENDING_VALIDATION' }), summary(5, { DomainName: 'other.example.com' })] }
					: {
						CertificateSummaryList: [
							summary(1),
							summary(2, { SubjectAlternativeNameSummaries: [HOST, 'other.example.com'] }),
							summary(3, { HasAdditionalSubjectAlternativeNames: true }),
							summary(6, { Type: 'IMPORTED' }),
							summary(7, { Type: 'PRIVATE' }),
							summary(8, { DomainName: `*.example.com`, SubjectAlternativeNameSummaries: ['*.example.com'] }),
						],
						NextToken: 'page-2',
					},
		})
		const found = await acmPlatformCertificates(options).findCertificates(HOST)
		// The issued one before a later request still waiting: an abandoned request does not hide a usable certificate.
		expect(found).toEqual([
			{ arn: arn(1), host: HOST, status: 'ISSUED', createdAt: 1_700_000_001 },
			{ arn: arn(4), host: HOST, status: 'PENDING_VALIDATION', createdAt: 1_700_000_004 },
		])
		expect(calls.map((call) => call.body)).toEqual([
			{ CertificateStatuses: ['PENDING_VALIDATION', 'ISSUED'], MaxItems: 1000 },
			{ CertificateStatuses: ['PENDING_VALIDATION', 'ISSUED'], MaxItems: 1000, NextToken: 'page-2' },
		])
	})

	test("Control's client stays two calls; the operator's adds the listing alone", () => {
		expect(Object.keys(acmPlatformCertificates(fakeAws(ACM, {}).options)).sort()).toEqual([
			'describeCertificate',
			'findCertificates',
			'requestCertificate',
		])
	})
})
