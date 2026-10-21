import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MailContentDto } from '../lib/api'
import { MailContent } from '../routes/mail/detail'

const render = (content: MailContentDto, sender = 'notes@prod') => renderToStaticMarkup(createElement(MailContent, { content, sender }))

describe("a relayed message's content", () => {
	test('the HTML body renders only in a frame that runs no script and fetches nothing, never in the page', () => {
		const markup = render({
			kind: 'present',
			message: {
				to: 'ada@example.com',
				subject: 'Hi',
				text: 'plain <b>text</b>',
				html: '<script>steal()</script><img src="https://tracker.example/p.gif">',
				attachments: [],
			},
		})
		expect(markup).not.toContain('<script>')
		expect(markup).not.toContain('<img')
		expect(markup).not.toContain('<b>')
		expect(markup).toMatch(/<iframe [^>]*sandbox=""/)
		expect(markup).toContain('srcDoc="&lt;meta http-equiv=&quot;Content-Security-Policy&quot; content=&quot;default-src &#x27;none&#x27;')
	})

	test('attachments are listed by name, type and size', () => {
		const markup = render({
			kind: 'present',
			message: { to: 'ada@example.com', subject: 'Hi', text: '', attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', bytes: 12 }] },
		})
		expect(markup).toContain('invoice.pdf')
		expect(markup).toContain('application/pdf')
		expect(markup).toContain('12 B')
	})

	test('withheld and purged content say why nothing is shown', () => {
		expect(render({ kind: 'withheld' })).toContain('mail.content.read')
		expect(render({ kind: 'purged' })).toContain('no longer keeps')
	})

	test("an installation service's withheld content says it is never shown, not which permission would show it", () => {
		const markup = render({ kind: 'withheld' }, 'installation:iam')
		expect(markup).toContain('never shown')
		expect(markup).not.toContain('mail.content.read')
	})
})
