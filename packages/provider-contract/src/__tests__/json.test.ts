import { describe, expect, mock, test } from 'bun:test'
import { decodeEnvelope, type JsonValue, type ProviderCodec } from '..'

interface HarborTarget {
	region: string
}

const objectProperty = (value: JsonValue, property: string): JsonValue => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('expected an object')
	}
	const propertyValue = value[property]
	if (propertyValue === undefined) {
		throw new Error(`missing ${property}`)
	}
	return propertyValue
}

const stringProperty = (value: JsonValue, property: string): string => {
	const propertyValue = objectProperty(value, property)
	if (typeof propertyValue !== 'string') {
		throw new Error(`${property} must be a string`)
	}
	return propertyValue
}

const targetCodec: ProviderCodec<HarborTarget> = {
	version: 3,
	encode: (target) => ({ region: target.region }),
	decode: (payload) => ({ region: stringProperty(payload, 'region') }),
}

describe('decodeEnvelope', () => {
	test('checks provider ownership before schema version without invoking the codec', () => {
		const decode = mock(targetCodec.decode)
		const codec = { ...targetCodec, decode }
		const envelope = { provider: 'other', version: 2, payload: { region: 'eu-west' } }

		expect(() => decodeEnvelope('target', 'harbor', envelope, codec)).toThrow('target belongs to provider "other", expected "harbor"')
		expect(decode).not.toHaveBeenCalled()
		expect(() => decodeEnvelope('target', 'harbor', { ...envelope, provider: 'harbor' }, codec)).toThrow(
			'target schema version 2 is not supported by provider "harbor"',
		)
		expect(decode).not.toHaveBeenCalled()
	})

	test('propagates the codec exception unchanged', () => {
		const failure = new Error('invalid target payload')
		const codec: ProviderCodec<HarborTarget> = {
			...targetCodec,
			decode: () => {
				throw failure
			},
		}
		let caught: unknown

		try {
			decodeEnvelope('target', 'harbor', { provider: 'harbor', version: 3, payload: {} }, codec)
		} catch (error) {
			caught = error
		}

		expect(caught).toBe(failure)
	})
})
