// A grant's scope values in the console (ADR-0085): checkboxes from the values the application lists, a value the grant
// holds that the list no longer has shown checked and flagged, and free text under a warning when nothing is listed.

import { MAX_GRANT_SCOPE_VALUES } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolveScope, scopedValue, ScopeValuesField, valuesFromText } from '../access/components/ScopePicker'
import { fmtGrantScope } from '../access/lib/format'

const organization = {
	type: 'organization',
	label: 'Organization',
	values: [{ value: 'acme', label: 'Acme Corporation' }, { value: 'globex' }],
}

function render(dimension: Parameters<typeof ScopeValuesField>[0]['dimension'], values: string[]): string {
	const value = scopedValue(dimension.type, values)
	if (value.kind !== 'scoped') throw new Error('scoped')
	return renderToStaticMarkup(<ScopeValuesField dimension={dimension} value={value} onChange={() => {}} idPrefix="t" />)
}

/** The checkboxes a render shows, as `[id, checked]`. */
function checkboxes(html: string): [string, boolean][] {
	return [...html.matchAll(/<input id="([^"]+)" type="checkbox"( checked="")?/g)].map((match) => [match[1] ?? '', match[2] !== undefined])
}

describe('the values of a grant', () => {
	test('a dimension that lists its values offers one checkbox each, with its label, and checks the ones the grant holds', () => {
		const html = render(organization, ['globex'])
		expect(checkboxes(html)).toEqual([['t-value-acme', false], ['t-value-globex', true]])
		expect(html).toContain('Acme Corporation')
		expect(html).not.toContain('textarea')
		expect(html).not.toContain('not listed')
	})

	test('a value the application no longer lists stays checked and flagged, never dropped', () => {
		const html = render(organization, ['acme', 'initech'])
		expect(checkboxes(html)).toEqual([['t-value-acme', true], ['t-value-globex', false], ['t-value-initech', true]])
		expect(html).toContain('not listed')
		expect(html).toContain('no longer lists')
	})

	test('a dimension that lists no values falls back to free text, one value per line, under a warning', () => {
		const html = render({ type: 'workspace' }, ['alpha', 'beta'])
		expect(checkboxes(html)).toEqual([])
		expect(html).toContain('<textarea')
		expect(html).toContain('alpha\nbeta')
		expect(html).toContain('lists no values of workspace, so nothing checks these')
		expect(valuesFromText(' alpha\r\n\nbeta\nalpha \n')).toEqual(['alpha', 'beta'])
	})

	test('the chosen values are sent as one grant; none, or more than a grant holds, is refused before sending', () => {
		expect(resolveScope(scopedValue('organization', ['globex', 'acme']))).toEqual({ scopeType: 'organization', scopeValues: ['globex', 'acme'] })
		expect(() => resolveScope(scopedValue('organization'))).toThrow('at least one value')
		const many = Array.from({ length: MAX_GRANT_SCOPE_VALUES + 1 }, (_, index) => `v${index}`)
		expect(() => resolveScope(scopedValue('organization', many))).toThrow(`at most ${MAX_GRANT_SCOPE_VALUES} values`)
	})

	test('a grant reads as its dimension and every value it holds', () => {
		expect(fmtGrantScope({ scopeType: 'organization', scopeValue: 'acme', scopeValues: ['acme', 'globex'] })).toBe('organization = acme, globex')
		expect(fmtGrantScope({ scopeType: null, scopeValue: null, scopeValues: null })).toBe('Global')
	})
})
