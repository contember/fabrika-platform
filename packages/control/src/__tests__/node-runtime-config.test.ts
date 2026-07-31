import { describe, expect, test } from 'bun:test'
import { readIamRpcProcessConfig } from '../node/runtime'

describe('the Node IAM RPC process configuration', () => {
	test('uses the private RPC origin independently of the public issuer', () => {
		expect(readIamRpcProcessConfig({
			FABRIKA_IAM_URL: 'https://iam.example.test',
			FABRIKA_IAM_RPC_URL: 'http://iam:3000',
			FABRIKA_IAM_RPC_KEY: 'rpc-key-with-at-least-thirty-two-characters',
		})).toEqual({
			origin: 'http://iam:3000',
			key: 'rpc-key-with-at-least-thirty-two-characters',
		})
	})

	test('does not fall back to the public issuer', () => {
		expect(() =>
			readIamRpcProcessConfig({
				FABRIKA_IAM_URL: 'https://iam.example.test',
				FABRIKA_IAM_RPC_KEY: 'rpc-key-with-at-least-thirty-two-characters',
			})
		).toThrow('FABRIKA_IAM_RPC_URL is required')
	})

	test('accepts deprecated RPC names while canonical values win when both are set', () => {
		expect(readIamRpcProcessConfig({
			PROPUSTKA_RPC_URL: 'http://legacy-iam:3000',
			PROPUSTKA_RPC_KEY: 'legacy-key-with-at-least-thirty-two-characters',
		})).toEqual({
			origin: 'http://legacy-iam:3000',
			key: 'legacy-key-with-at-least-thirty-two-characters',
		})

		expect(readIamRpcProcessConfig({
			FABRIKA_IAM_RPC_URL: 'http://iam:3000',
			PROPUSTKA_RPC_URL: 'http://legacy-iam:3000',
			FABRIKA_IAM_RPC_KEY: 'canonical-key-with-at-least-thirty-two-characters',
			PROPUSTKA_RPC_KEY: 'legacy-key-with-at-least-thirty-two-characters',
		})).toEqual({
			origin: 'http://iam:3000',
			key: 'canonical-key-with-at-least-thirty-two-characters',
		})
	})
})
