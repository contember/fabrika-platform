import { renderAnnotation } from '@fabrika/annotations'
import { mountContainer } from '@fabrika/annotations/testing/dom.ts'
import { afterEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MarkdownPreview, renderUntrustedMarkdown } from './ResponsePreview'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => {
	await act(async () => root?.unmount())
	root = undefined
})

async function renderPreview(text: string): Promise<HTMLElement> {
	const container = mountContainer('')
	root = createRoot(container)
	await act(async () => root?.render(<MarkdownPreview text={text} />))
	return container
}

/** Every element carrying an event handler attribute or a URL with a script scheme. */
function activeContent(container: HTMLElement): string[] {
	const found: string[] = []
	for (const el of container.querySelectorAll('*')) {
		for (const attr of el.getAttributeNames()) {
			const value = el.getAttribute(attr) ?? ''
			if (attr.startsWith('on')) found.push(`${el.tagName} ${attr}`)
			if (/^\s*(javascript|vbscript|data):/i.test(value)) found.push(`${el.tagName} ${attr}=${value}`)
		}
	}
	return found
}

const HOSTILE = [
	'<img src=x onerror="globalThis.__pwned = 1">',
	'<svg onload="globalThis.__pwned = 1"></svg>',
	'inline <img src=x onerror=alert(1)> tag',
	'[click](javascript:alert(1))',
	'[click](JaVaScRiPt:alert(1))',
	'[click](java\tscript:alert(1))',
	'[click](vbscript:msgbox(1))',
	'[click]( \u0001JAVASCRIPT:alert(1))',
	'[click](file:///etc/passwd)',
	'[click](data:text/html,<script>alert(1)</script>)',
	'![x](javascript:alert(1))',
	'<javascript:alert(1)>',
	'[ref]\n\n[ref]: javascript:alert(1)',
	'<a href="javascript:alert(1)">x</a>',
	'<script>globalThis.__pwned = 1</script>',
	'<iframe src="javascript:alert(1)"></iframe>',
	'a <pre> <img src=x onerror=alert(1)//',
	'a <script> <img src=x onerror=alert(1)//',
	'a <CODE class=x> <img src=x onerror=alert(1)//',
	'a <kbd> <img src=x onerror=alert(1)//',
	'x <pre>\n\n<img src=x onerror=alert(1)//',
]

describe('MarkdownPreview over reviewer-authored text', () => {
	for (const payload of HOSTILE) {
		test(`renders inert: ${JSON.stringify(payload)}`, async () => {
			const container = await renderPreview(payload)
			expect(activeContent(container)).toEqual([])
			expect(container.querySelector('script, iframe, svg, object, embed')).toBeNull()
		})
	}

	test('a remote annotation with markup in every field renders it as text', async () => {
		const md = renderAnnotation({
			snippet: '<img src=x onerror=alert(1)>',
			note: 'see <svg onload=alert(1)></svg> and [here](javascript:alert(1)) <pre> <img src=x onerror=alert(5)//',
			filePath: '<img src=x onerror=alert(2)>',
			context: { before: '<b onmouseover=alert(3)>', after: '', hierarchy: [] },
			attachments: [{ url: 'javascript:alert(4)', mime: 'image/png' }],
		})
		const container = await renderPreview(md)
		expect(activeContent(container)).toEqual([])
		expect(container.querySelector('img, svg, b')).toBeNull()
		expect(container.textContent).toContain('<svg onload=alert(1)></svg>')
		expect(container.textContent).toContain('here')
	})
})

describe('MarkdownPreview keeps ordinary markdown', () => {
	test('emphasis, code, headings and lists', async () => {
		const container = await renderPreview('# Title\n\n**bold** and `code`\n\n- one\n- two\n\n```ts\nconst a = 1 < 2\n```')
		expect(container.querySelector('h1')?.textContent).toBe('Title')
		expect(container.querySelector('strong')?.textContent).toBe('bold')
		expect(container.querySelector('p code')?.textContent).toBe('code')
		expect(container.querySelectorAll('li')).toHaveLength(2)
		expect(container.querySelector('pre code')?.textContent).toBe('const a = 1 < 2\n')
	})

	test('entities in text show as the characters they name', async () => {
		const container = await renderPreview('AT&amp;T &lt;b&gt; &copy;')
		expect(container.textContent?.trim()).toBe('AT&T <b> ©')
		expect(container.querySelector('b')).toBeNull()
	})

	test('https, mailto and relative links keep their href', async () => {
		const container = await renderPreview('[site](https://example.com/a?b=1) [mail](mailto:a@example.com) [rel](/s/abc) [frag](#x)')
		const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))
		expect(hrefs).toEqual(['https://example.com/a?b=1', 'mailto:a@example.com', '/s/abc', '#x'])
	})

	test('an upload image under any runtime directory is rewritten to the uploads API and an https image kept', async () => {
		const container = await renderPreview(
			'![a](/run/user/1000/agent-canvas/uploads/a.png) ![b](/tmp/agent-canvas-1000/uploads/b.png) ![c](/tmp/agent-canvas/uploads/c.png)'
				+ '\n\n![remote](https://example.com/i.png)',
		)
		const srcs = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'))
		expect(srcs).toEqual(['/api/uploads/a.png', '/api/uploads/b.png', '/api/uploads/c.png', 'https://example.com/i.png'])
	})
})

describe('renderUntrustedMarkdown', () => {
	test('escapes raw HTML instead of passing it through', () => {
		expect(renderUntrustedMarkdown('<b>x</b>')).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>\n')
	})

	test('a link with a script URL renders as its text only', () => {
		expect(renderUntrustedMarkdown('[**go**](javascript:alert(1))')).toBe('<p><strong>go</strong></p>\n')
	})
})
