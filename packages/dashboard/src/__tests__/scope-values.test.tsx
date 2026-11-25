// A grant's scope values in the console (ADR-0085): checkboxes from the values the application lists, a value the grant
// holds that the list no longer has shown checked and flagged, and free text under a warning when nothing is listed.

import { MAX_GRANT_SCOPE_VALUES } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolveScope, scopedValue, ScopeValuesChoice, ScopeValuesField, valueMatches, valuesFromText } from '../access/components/ScopePicker'
import { fmtGrantScope } from '../access/lib/format'
import { type LiveScopeValues, unavailableReason } from '../access/lib/useLiveScopeValues'

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

/** A render of a dimension whose values come from the application, in the state `live` of its answer. */
function renderLive(live: LiveScopeValues, values: string[], declared: { value: string; label?: string }[] = []): string {
	const value = scopedValue('organization', values)
	if (value.kind !== 'scoped') throw new Error('scoped')
	const dimension = {
		type: 'organization',
		label: 'Organization',
		values: declared,
		valueSource: { endpoint: 'api.organizationValues', path: '/api/organizationValues', action: 'orgs.read' },
	}
	return renderToStaticMarkup(<ScopeValuesChoice dimension={dimension} live={live} value={value} onChange={() => {}} idPrefix="t" />)
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

	test("the application's own values: checkboxes from its answer, a held value it no longer lists flagged, never dropped", () => {
		const html = renderLive({ status: 'live', values: [{ value: 'acme', label: 'Acme Corporation' }, { value: 'umbrella' }] }, ['initech'], [{
			value: 'globex',
		}])
		expect(checkboxes(html)).toEqual([['t-value-acme', false], ['t-value-umbrella', false], ['t-value-initech', true]])
		expect(html).toContain('Acme Corporation')
		expect(html).not.toContain('globex')
		expect(html).toContain('not listed')
		expect(html).not.toContain('Could not load')
	})

	test('while the application is asked, a status line; no checkbox and no free text yet', () => {
		const html = renderLive({ status: 'loading' }, ['acme'])
		expect(html).toContain('role="status"')
		expect(html).toContain('Loading the values of Organization')
		expect(checkboxes(html)).toEqual([])
		expect(html).not.toContain('<textarea')
	})

	test('an application that does not answer falls back to the declared list, under a warning naming why', () => {
		const html = renderLive({ status: 'unavailable', reason: 'timeout' }, ['acme', 'initech'], [{ value: 'acme' }, { value: 'globex' }])
		expect(checkboxes(html)).toEqual([['t-value-acme', true], ['t-value-globex', false], ['t-value-initech', true]])
		expect(html).toContain('Could not load the values of Organization from the application: the application did not answer in time.')
		expect(html).toContain('Showing the values the application declares instead.')
		expect(html).toContain('not listed')
	})

	test('with no declared list either, it falls back to free text, keeping every held value', () => {
		const html = renderLive({ status: 'unavailable', reason: 'not_held' }, ['acme', 'initech'])
		expect(checkboxes(html)).toEqual([])
		expect(html).toContain('<textarea')
		expect(html).toContain('acme\ninitech')
		expect(html).toContain('you do not hold the permission the application asks for to list them')
		expect(html).toContain('Enter the IDs by hand.')
	})

	test('each value is one row: the label and the ID cut with an ellipsis, both in full in its tooltip', () => {
		const label = 'Globex Corporation Internal Knowledge Base (globex-internal-knowledge-base)'
		const id = '01a1fdbe-309d-70d5-ab6e-3337262984b4'
		const html = renderLive({ status: 'live', values: [{ value: id, label }, { value: 'acme' }] }, [])
		const rows = [...html.matchAll(/<label for="t-value-[^"]+" class="checkbox" title="([^"]*)">(.*?)<\/label>/g)]
		expect(rows.map((row) => row[1])).toEqual([`${label} · ${id}`, 'acme'])
		expect(rows[0]?.[2]).toContain(`<span class="truncate">${label}</span><span class="truncate muted small">${id}</span>`)
		expect(rows[1]?.[2]).toContain('<code class="truncate">acme</code>')
		expect(html).toContain('<div class="scope-value-list">')
	})

	test('past eight values a filter narrows the rows by label or ID; eight or fewer need none', () => {
		const values = (count: number) => Array.from({ length: count }, (_, index) => ({ value: `w${index}`, label: `Workspace ${index}` }))
		expect(renderLive({ status: 'live', values: values(8) }, [])).not.toContain('type="search"')
		expect(renderLive({ status: 'live', values: values(9) }, [])).toContain('type="search"')
		expect(renderLive({ status: 'live', values: values(8) }, ['gone'])).toContain('type="search"')
		const entry = { value: '01a1fdbe-309d', label: 'Acme Corporation (acme)' }
		expect(valueMatches(entry, '')).toBe(true)
		expect(valueMatches(entry, '  CORPORATION ')).toBe(true)
		expect(valueMatches(entry, '309d')).toBe(true)
		expect(valueMatches(entry, 'globex')).toBe(false)
		expect(valueMatches({ value: 'acme' }, 'corp')).toBe(false)
	})

	test('every reason reads as a sentence', () => {
		const reasons = ['no_source', 'not_held', 'no_origin', 'refused', 'timeout', 'unreachable', 'malformed', 'failed'] as const
		const sentences = reasons.map(unavailableReason)
		expect(new Set(sentences).size).toBe(reasons.length)
		for (const sentence of sentences) expect(sentence).toMatch(/^[a-z].*[a-z]$/)
	})
})
