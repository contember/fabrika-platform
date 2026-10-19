// The module rules that wait for the contract: `cross-app-fetch` accepts an absolute URL whose origin a site declares in
// `egress`, and `url-endpoint` refuses a literal `ctx.url` id that names no procedure. Over the signed-token fixture, a
// kit whose job builds an unsubscribe link with `ctx.url`.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { checkApplication } from '../check'
import type { RuleId } from '../finding'
import { readTree } from './colocated-helpers'

const ROOT = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'token-fixture')
const ENDPOINTS = 'src/mail/endpoints.ts'
const NEWSLETTER = "egress: ['https://lists.example.com'],"
const LINK = "ctx.url('api.mail.unsubscribe', { query: { t } })"

/** The fixture, with `edit` applied to its endpoints module when given, checked; the findings of `rule`. */
const findingsOf = async (rule: RuleId, edit?: (text: string) => string): Promise<string[]> => {
	const files = readTree(ROOT)
	const text = files.get(ENDPOINTS) ?? ''
	if (edit !== undefined) {
		const edited = edit(text)
		expect(edited).not.toBe(text)
		files.set(ENDPOINTS, edited)
	}
	const findings = await checkApplication({ root: '/application', files })
	return findings.filter((finding) => finding.rule === rule).map((finding) => `${finding.line}:${finding.column} ${finding.message}`)
}

/** The newsletter job, declaring `egress` and calling `urls` before it sends. */
const calling = (egress: string, ...urls: string[]) => (text: string): string =>
	text.replace(NEWSLETTER, `egress: [${egress}],`).replace(
		'const t = ctx.tokens.sign(',
		`${urls.map((url) => `await fetch('${url}')\n\t\t`).join('')}const t = ctx.tokens.sign(`,
	)

describe('cross-app-fetch', () => {
	test('accepts a URL within a declared origin, and refuses another origin and a host that only starts like one', async () => {
		const found = await findingsOf(
			'cross-app-fetch',
			calling("'https://api.example.com'", 'https://api.example.com/v1/lists', 'https://other.example.com/x', 'https://api.example.com.evil.net/'),
		)
		expect(found).toHaveLength(2)
		expect(found[0]).toContain("'https://other.example.com/x'")
		expect(found[1]).toContain("'https://api.example.com.evil.net/'")
	})

	test('refuses every absolute URL where no site declares egress', async () => {
		expect(
			await findingsOf(
				'cross-app-fetch',
				(text) => text.replace('const t = ctx.tokens.sign(', "await fetch('https://api.example.com/v1')\n\t\tconst t = ctx.tokens.sign("),
			),
		)
			.toHaveLength(1)
	})
})

describe('url-endpoint', () => {
	test('accepts the id of a procedure, and refuses one that names none', async () => {
		expect(await findingsOf('url-endpoint')).toEqual([])
		expect(await findingsOf('url-endpoint', (text) => text.replace(LINK, "ctx.url('api.mail.unsubscrbe', { query: { t } })"))).toEqual([
			expect.stringContaining("ctx.url names 'api.mail.unsubscrbe', which is no procedure of the contract"),
		])
	})
})
