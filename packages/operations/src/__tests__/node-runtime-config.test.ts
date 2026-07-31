import { describe, expect, test } from 'bun:test'
import { resolveOperationsIamProcessConfig } from '../node/runtime'

const CANONICAL_KEY = 'canonical-rpc-key-with-32-characters'
const LEGACY_KEY = 'legacy-rpc-key-with-at-least-32-characters'

describe('Operations IAM process configuration', () => {
	test('resolves canonical public and private IAM endpoints independently', () => {
		expect(
			resolveOperationsIamProcessConfig({
				FABRIKA_IAM_URL: 'https://iam.example.test',
				FABRIKA_IAM_RPC_URL: 'http://iam:3000',
				FABRIKA_IAM_RPC_KEY: CANONICAL_KEY,
			}),
		).toEqual({
			issuer: 'https://iam.example.test',
			rpcOrigin: 'http://iam:3000',
			rpcKey: CANONICAL_KEY,
		})
	})

	test('retains legacy IAM aliases at the process boundary', () => {
		expect(
			resolveOperationsIamProcessConfig({
				PROPUSTKA_URL: 'https://legacy-iam.example.test',
				PROPUSTKA_RPC_URL: 'http://legacy-iam:3000',
				PROPUSTKA_RPC_KEY: LEGACY_KEY,
			}),
		).toEqual({
			issuer: 'https://legacy-iam.example.test',
			rpcOrigin: 'http://legacy-iam:3000',
			rpcKey: LEGACY_KEY,
		})
	})

	test('canonical values win when both name families are set', () => {
		expect(
			resolveOperationsIamProcessConfig({
				FABRIKA_IAM_URL: 'https://iam.example.test',
				PROPUSTKA_URL: 'https://ignored.example.test',
				FABRIKA_IAM_RPC_URL: 'http://iam:3000',
				PROPUSTKA_RPC_URL: 'http://ignored-iam:3000',
				FABRIKA_IAM_RPC_KEY: CANONICAL_KEY,
				PROPUSTKA_RPC_KEY: LEGACY_KEY,
			}),
		).toEqual({
			issuer: 'https://iam.example.test',
			rpcOrigin: 'http://iam:3000',
			rpcKey: CANONICAL_KEY,
		})
	})

	test('reports canonical names when required IAM configuration is absent', () => {
		expect(() => resolveOperationsIamProcessConfig({})).toThrow('FABRIKA_IAM_URL is required')
		expect(() =>
			resolveOperationsIamProcessConfig({
				FABRIKA_IAM_URL: 'https://iam.example.test',
			})
		).toThrow('FABRIKA_IAM_RPC_URL is required')
		expect(() =>
			resolveOperationsIamProcessConfig({
				FABRIKA_IAM_URL: 'https://iam.example.test',
				FABRIKA_IAM_RPC_URL: 'http://iam:3000',
			})
		).toThrow('FABRIKA_IAM_RPC_KEY is required')
	})
})
