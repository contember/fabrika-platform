import { describe, expect, test } from 'bun:test'
import { mailHtmlTokens, mailTemplateProblems } from '../mail'

const TEXT = 'Join {{displayName}}: {{actionUrl}}'

const problemsOf = (html: string): string[] => mailTemplateProblems('invitation', { subject: 'Join us', text: TEXT, html })

describe("an application's HTML body of an IAM e-mail", () => {
	test('admits text structure, closed placeholders and links to the action, the application and a mailbox', () => {
		const html = '<h1>Welcome, {{recipient}}</h1><p><strong>{{inviterLabel}}</strong> invites you &amp; your team.<br>'
			+ '<a href="{{actionUrl}}">Accept</a> · <a href="{{appUrl}}">About</a> · <a href="mailto:help@example.test">Help</a></p>'
			+ '<ul><li>{{companyLabel}}</li></ul><hr/>'
		expect(problemsOf(html)).toEqual([])
		expect(mailHtmlTokens('<p>A <a href="{{actionUrl}}">link</a></p>')).toEqual({
			ok: true,
			tokens: [
				{ kind: 'open', name: 'p', href: null },
				{ kind: 'text', text: 'A ' },
				{ kind: 'open', name: 'a', href: '{{actionUrl}}' },
				{ kind: 'text', text: 'link' },
				{ kind: 'close', name: 'a' },
				{ kind: 'close', name: 'p' },
			],
		})
	})

	test.each([
		['a script', '<p><a href="{{actionUrl}}">x</a></p><script>alert(1)</script>'],
		['a style', '<style>p{background:url(https://evil.test/x)}</style><a href="{{actionUrl}}">x</a>'],
		['a form', '<form action="https://evil.test"><a href="{{actionUrl}}">x</a></form>'],
		['a frame', '<iframe src="https://evil.test"></iframe><a href="{{actionUrl}}">x</a>'],
		['an image, a remote resource', '<img src="https://evil.test/pixel.png"><a href="{{actionUrl}}">x</a>'],
		['an event handler', '<p onclick="alert(1)"><a href="{{actionUrl}}">x</a></p>'],
		['a style attribute', '<p style="background:url(https://evil.test/x)"><a href="{{actionUrl}}">x</a></p>'],
		['a javascript: URL', '<a href="javascript:alert(1)">x</a><a href="{{actionUrl}}">y</a>'],
		['a data: URL', '<a href="data:text/html,x">x</a><a href="{{actionUrl}}">y</a>'],
		['another origin', '<a href="https://evil.test/">x</a><a href="{{actionUrl}}">y</a>'],
		['an action URL inside a longer address', '<a href="{{actionUrl}}&x=1">x</a>'],
		['a single-quoted attribute', "<a href='{{actionUrl}}'>x</a>"],
		['an upper-case element', '<P><a href="{{actionUrl}}">x</a></P>'],
		['a comment', '<!--[if mso]><a href="https://evil.test">x</a><![endif]--><a href="{{actionUrl}}">x</a>'],
		['an unbalanced element', '<p><a href="{{actionUrl}}">x</a>'],
		['a misnested element', '<p><strong><a href="{{actionUrl}}">x</a></p></strong>'],
		['a link inside a link', '<a href="{{actionUrl}}"><a href="{{appUrl}}">x</a></a>'],
		['a bare ampersand', '<p>You & me <a href="{{actionUrl}}">x</a></p>'],
		['a bare less-than', '<p>1 < 2 <a href="{{actionUrl}}">x</a></p>'],
		['no action link', '<p>Open {{actionUrl}} yourself</p>'],
		['an unknown placeholder', '<p>{{password}} <a href="{{actionUrl}}">x</a></p>'],
	])('refuses %s', (_, html) => {
		expect(problemsOf(html).length).toBeGreaterThan(0)
	})

	test('refuses an HTML body above its byte bound, and a template without one stays as before', () => {
		expect(problemsOf(`<p>${'x'.repeat(16 * 1024)}</p><a href="{{actionUrl}}">x</a>`)).toEqual(['the HTML is longer than 16384 bytes'])
		expect(mailTemplateProblems('invitation', { subject: 'Join us', text: TEXT })).toEqual([])
	})
})
