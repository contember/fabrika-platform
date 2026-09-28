import { describe, expect, test } from 'bun:test'
import { parseZeropsDescriptor, prepareZeropsDescriptor } from '../descriptor'
import { descriptorCorpus, rejectedDescriptorCorpus } from './fixtures/descriptor-corpus'

describe('supported Zerops descriptor subset', () => {
	for (const fixture of descriptorCorpus) {
		test(fixture.name, () => {
			expect(parseZeropsDescriptor(fixture.source).document).toEqual(fixture.expected)
			const prepared = prepareZeropsDescriptor(fixture.source)
			expect(prepared.setup).toBe('api')
			expect(parseZeropsDescriptor(prepared.contents).document).toEqual(fixture.expected)
		})
	}
	for (const [name, source] of rejectedDescriptorCorpus) {
		test(`rejects ${name}`, () => {
			expect(() => parseZeropsDescriptor(source)).toThrow('zerops.yaml')
		})
	}
	test('selects one setup explicitly without dropping other setups', () => {
		const source = 'zerops: [{setup: api}, {setup: worker, extra: retained}]'
		expect(() => prepareZeropsDescriptor(source)).toThrow('explicit setup selector')
		expect(() => prepareZeropsDescriptor(source, 'missing')).toThrow('selected setup')
		const prepared = prepareZeropsDescriptor(source, 'worker')
		expect(prepared.setup).toBe('worker')
		expect(parseZeropsDescriptor(prepared.contents).setups).toEqual(['api', 'worker'])
		expect(prepared.contents).toContain('extra: retained')
	})
	test('quoted ambiguous scalars remain strings in keys and values', () => {
		for (const value of ['012', 'yes', 'y', 'n', 'ON', '1:20', '2026-09-23']) {
			const source = `zerops: [{setup: api, extra: {${JSON.stringify(value)}: ${JSON.stringify(value)}}}]`
			expect(parseZeropsDescriptor(prepareZeropsDescriptor(source).contents).document).toEqual({ zerops: [{ setup: 'api', extra: { [value]: value } }] })
		}
	})
	test('diagnostics never echo scalar values or parser excerpts', () => {
		for (const value of ['!!str secret-do-not-print', '!unknown secret-do-not-print', '[secret-do-not-print']) {
			try {
				parseZeropsDescriptor(`zerops: [{setup: api, x: ${value}}]`)
				throw new Error('expected refusal')
			} catch (error) {
				expect(error).toBeInstanceOf(Error)
				expect(String(error)).toContain('zerops.yaml')
				expect(String(error)).not.toContain('secret-do-not-print')
			}
		}
	})
})
