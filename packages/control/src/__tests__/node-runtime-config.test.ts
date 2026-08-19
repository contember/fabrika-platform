import { describe, expect, test } from 'bun:test'
import { readIamRpcProcessConfig } from '../node/runtime'

describe('the Node IAM RPC process configuration', () => {
	test('uses the private RPC origin independently of the public issuer', () => {
		expect(readIamRpcProcessConfig({
			FABRIKA_IAM_ISSUER: 'https://iam.example.test',
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
				FABRIKA_IAM_ISSUER: 'https://iam.example.test',
				FABRIKA_IAM_RPC_KEY: 'rpc-key-with-at-least-thirty-two-characters',
			})
		).toThrow('FABRIKA_IAM_RPC_URL is required')
	})
})
