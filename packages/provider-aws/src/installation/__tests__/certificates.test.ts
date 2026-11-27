// The installation's certificates: a request's token the same for the same host and of the form ACM takes; a
// certificate ACM describes as naming more than its host refused as one; a fresh request read again until ACM names
// its record; and the statuses an install waits for, goes on with, or refuses.

import { describe, expect, test } from 'bun:test'
import type { Certificate } from '../../aws/acm'
import { AwsError } from '../../aws/json'
import { awsCertificatesIssued, type AwsCertificatesWhere, awsCertificateToken, checkedAwsCertificate, requestAwsCertificates } from '../certificates'

const ARN = 'arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-000000000001'
const HOST = 'iam.example.com'
const RECORD = { name: '_a1.iam.example.com.', value: '_b2.abcdefgh.acm-validations.aws.' }

function where(describe: (arn: string) => Promise<Certificate | null>): AwsCertificatesWhere {
	return {
		accountId: '123456789012',
		region: 'eu-central-1',
		acm: {
			describeCertificate: describe,
			findCertificates: async () => [],
			requestCertificate: async () => ARN,
		},
		signal: new AbortController().signal,
	}
}

describe("the installation's certificates", () => {
	test("a request's token is the host's own, the same on every run, and of the form ACM takes", () => {
		expect(awsCertificateToken(HOST)).toBe(awsCertificateToken(HOST))
		expect(awsCertificateToken(HOST)).not.toBe(awsCertificateToken('control.example.com'))
		expect(awsCertificateToken(HOST)).toMatch(/^\w{1,32}$/)
	})

	test('a certificate ACM describes as naming more than its host, or a wildcard, is refused as one', async () => {
		const several = where(async () => {
			throw new AwsError('DescribeCertificate', 'invalid_answer', 200, null, false)
		})
		await expect(checkedAwsCertificate(several, 'iam', HOST, ARN)).rejects.toThrow(
			`--iam-certificate ${ARN} is not a certificate of exactly iam.example.com`,
		)
		// Any other failure is ACM's own, passed on.
		const denied = where(async () => {
			throw new AwsError('DescribeCertificate', 'AccessDeniedException', 400, null, false)
		})
		await expect(checkedAwsCertificate(denied, 'iam', HOST, ARN)).rejects.toMatchObject({ code: 'AccessDeniedException' })
		await expect(checkedAwsCertificate(denied, 'iam', HOST, 'not-an-arn')).rejects.toThrow('--iam-certificate is not a certificate')
	})

	test('a fresh request is read again until ACM names its record', async () => {
		let reads = 0
		const slept: number[] = []
		const requested = await requestAwsCertificates(
			{
				...where(async () => ({
					arn: ARN,
					host: HOST,
					status: 'PENDING_VALIDATION',
					validation: ++reads < 3 ? null : RECORD,
					inUseBy: [],
				})),
				sleep: async (ms) => {
					slept.push(ms)
				},
				log: () => {},
			},
			[{ slot: 'iam', host: HOST, certificate: null }],
		)
		expect(requested.map((entry) => entry.certificate.validation)).toEqual([RECORD])
		expect(slept).toEqual([5_000, 5_000])
	})

	test('issued goes on; pending names its record and waits; any other status is refused by its flag', () => {
		const lines: string[] = []
		const certificate = (status: Certificate['status'], validation: Certificate['validation'] = null): Certificate => ({
			arn: ARN,
			host: HOST,
			status,
			validation,
			inUseBy: [],
		})
		expect(awsCertificatesIssued([{ slot: 'iam', host: HOST, certificate: certificate('ISSUED') }], (line) => lines.push(line))).toBe(true)
		expect(awsCertificatesIssued([{ slot: 'iam', host: HOST, certificate: certificate('PENDING_VALIDATION', RECORD) }], (line) => lines.push(line)))
			.toBe(false)
		expect(lines).toEqual([`aws: iam.example.com: add the DNS record CNAME ${RECORD.name} -> ${RECORD.value}`])
		for (const status of ['EXPIRED', 'REVOKED', 'FAILED', 'VALIDATION_TIMED_OUT', 'INACTIVE'] satisfies Certificate['status'][]) {
			expect(() => awsCertificatesIssued([{ slot: 'iam', host: HOST, certificate: certificate(status) }], () => {})).toThrow(
				`is ${status}; name another with --iam-certificate`,
			)
		}
	})
})
