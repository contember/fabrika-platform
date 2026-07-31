import { describe, expect, test } from 'bun:test'
import { readIamIssuer } from '../env'

describe('readIamIssuer', () => {
	test('reads the canonical name', () => {
		expect(readIamIssuer({ FABRIKA_IAM_ISSUER: 'https://iam.example.com' })).toBe('https://iam.example.com')
	})

	test('retains the legacy fallback', () => {
		expect(readIamIssuer({ PROPUSTKA_ISSUER: 'https://legacy.example.com' })).toBe('https://legacy.example.com')
	})

	test('prefers the canonical name when both are set', () => {
		expect(
			readIamIssuer({ FABRIKA_IAM_ISSUER: 'https://iam.example.com', PROPUSTKA_ISSUER: 'https://legacy.example.com' }),
		).toBe('https://iam.example.com')
	})

	test('requires an IAM issuer', () => {
		expect(() => readIamIssuer({})).toThrow('FABRIKA_IAM_ISSUER is required')
	})
})
