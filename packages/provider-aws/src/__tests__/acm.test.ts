// The Certificate Manager client against the fake endpoint: a certificate requested for one host by DNS under an
// idempotency token, read back with its validation record, deleted; an answer of another form is refused, and an input
// of another form is refused before anything is sent.

import { describe, expect, test } from 'bun:test'
import { ACM, acmClient } from '../aws/acm'
import { awsError, fakeAws } from './helpers/fake-aws'

const ARN = 'arn:aws:acm:eu-central-1:123456789012:certificate/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'
const HOST = 'notes.example.com'
const RECORD = { Name: '_3f2a9c.notes.example.com.', Type: 'CNAME', Value: '_7b1d.abcdefgh.acm-validations.aws.' }

const described = (change: Record<string, unknown> = {}) => ({
	Certificate: {
		CertificateArn: ARN,
		DomainName: HOST,
		Status: 'PENDING_VALIDATION',
		DomainValidationOptions: [{ DomainName: HOST, ValidationStatus: 'PENDING_VALIDATION', ResourceRecord: RECORD }],
		...change,
	},
})

describe('acmClient', () => {
	test('requests a certificate for one host, validated by DNS, under its idempotency token and tags', async () => {
		const { options, calls } = fakeAws(ACM, { RequestCertificate: () => ({ CertificateArn: ARN }) })
		expect(await acmClient(options).requestCertificate({ host: HOST, token: 'a1b2c3', tags: { 'fabrika:namespace': 'shared' } })).toBe(ARN)
		expect(calls).toEqual([{
			operation: 'RequestCertificate',
			target: 'CertificateManager.RequestCertificate',
			body: { DomainName: HOST, ValidationMethod: 'DNS', IdempotencyToken: 'a1b2c3', Tags: [{ Key: 'fabrika:namespace', Value: 'shared' }] },
		}])
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
			]
		) {
			const { options } = fakeAws(ACM, { DescribeCertificate: () => described(change) })
			await expect(acmClient(options).describeCertificate(ARN)).rejects.toMatchObject({ code: 'invalid_answer' })
		}
	})

	test('deletes a certificate, and one that is not there answers false; one in use is refused by ACM', async () => {
		const { options, calls } = fakeAws(ACM, { DeleteCertificate: () => ({}) })
		expect(await acmClient(options).deleteCertificate(ARN)).toBe(true)
		expect(calls[0]?.body).toEqual({ CertificateArn: ARN })
		const gone = fakeAws(ACM, { DeleteCertificate: () => awsError('ResourceNotFoundException') })
		expect(await acmClient(gone.options).deleteCertificate(ARN)).toBe(false)
		const used = fakeAws(ACM, { DeleteCertificate: () => awsError('ResourceInUseException') })
		await expect(acmClient(used.options).deleteCertificate(ARN)).rejects.toMatchObject({ code: 'ResourceInUseException' })
	})

	test('refuses an input of another form before anything is sent', async () => {
		const { options, calls } = fakeAws(ACM, {})
		const acm = acmClient(options)
		for (const host of ['*.example.com', 'Notes.example.com', 'localhost', 'notes.example.com.', `${'a'.repeat(64)}.example.com`]) {
			await expect(acm.requestCertificate({ host, token: 'a1', tags: {} })).rejects.toThrow('the host')
		}
		await expect(acm.requestCertificate({ host: HOST, token: 'not-a-word', tags: {} })).rejects.toThrow('the idempotency token')
		await expect(acm.requestCertificate({ host: HOST, token: 'a'.repeat(33), tags: {} })).rejects.toThrow('the idempotency token')
		await expect(acm.requestCertificate({ host: HOST, token: 'a1', tags: { 'bad key!': 'x' } })).rejects.toThrow('the tags')
		await expect(acm.describeCertificate('arn:aws:s3:::bucket')).rejects.toThrow('the certificate')
		await expect(acm.deleteCertificate('arn:aws:s3:::bucket')).rejects.toThrow('the certificate')
		expect(calls).toEqual([])
	})
})
