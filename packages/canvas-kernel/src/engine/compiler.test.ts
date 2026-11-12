import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { canvasFileReferences, compileJsx, compilePlan } from './compiler'

// Regression coverage for the error-reporting path. Bun surfaces JSX syntax
// errors through three shapes (Transpiler throw, build logs, AggregateError
// from Bun.build); all must reach the CLI as an actionable message carrying a
// position + code frame — never a bare "Parse error" / "Bundle failed".

test('syntax error reports line, column and a code frame', async () => {
	// A straight double-quote inside a double-quoted attribute terminates the
	// attribute early — the exact mistake that previously printed only
	// "Parse error" with no location.
	const result = await compilePlan(`<Section title="a "b" c">x</Section>`)

	expect(result.ok).toBe(false)
	if (result.ok) return
	expect(result.error).toMatch(/\(line \d+, col \d+\)/)
	// Code frame: offending source line + caret.
	expect(result.error).toContain('^')
})

test('syntax error line maps back to the authored file (1-based, not offset by injected imports)', async () => {
	// Bad token on the authored 3rd line; the reported line must be small/positive,
	// not shifted by the prepended component-import preamble.
	const result = await compilePlan(`<Section title="ok">\n  <Item id="a" label="x">\n    <span a="1 "2"></span>\n  </Item>\n</Section>`)

	expect(result.ok).toBe(false)
	if (result.ok) return
	const m = result.error.match(/\(line (\d+), col \d+\)/)
	expect(m).not.toBeNull()
	const line = Number(m![1])
	expect(line).toBeGreaterThan(0)
	expect(line).toBeLessThan(10)
})

test('well-formed canvas compiles', async () => {
	const result = await compilePlan(`<Section title="Hello"><Item id="a" label="b">text</Item></Section>`)
	expect(result.ok).toBe(true)
})

// String contents decode to plain text in the bundle, so the validation must not match module syntax inside them.
test('module syntax inside string values neither runs nor breaks the validation', async () => {
	const injected = await compilePlan(
		`<Table headers={["Goal"]} rows={[["Remove the stale import {"], ["} from \\u0022x\\u0022\\u0022, globalThis.__canvasInjected=1, /*"], ["*/ ]]//"]]} />`,
	)
	expect(injected.ok).toBe(true)
	expect('__canvasInjected' in globalThis).toBe(false)

	const plain = await compilePlan(
		`<Table headers={["Goal"]} rows={[["Drop the unused import {"], ["Keep only } from \\u0022react\\u0022 in the header"]]} />`,
	)
	expect(plain.ok).toBe(true)
})

test('a canvas that imports a local module compiles: the bundle places its own imports after that module', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'canvas-compile-'))
	try {
		writeFileSync(join(dir, 'value.js'), 'export const value = "from a module"')
		const result = await compileJsx(
			`import { value } from ${JSON.stringify(join(dir, 'value.js'))}\nexport default function Plan() { return <Section title={value}>x</Section> }`,
			{ projectRoot: dir, tempDir: dir },
		)
		expect(result).toMatchObject({ ok: true })
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('a host component is unknown until the host declares it', async () => {
	const jsx = `<SecretInput id="service-token" label="Service token" env="SERVICE_TOKEN" required />`
	const components = { SecretInput: { requiredProps: { id: 'string', label: 'string', env: 'string' } } } as const

	expect((await compileJsx(jsx, { components })).ok).toBe(true)
	// Without the declaration the name is not destructured, so it is a free
	// variable and the render check catches it.
	expect((await compileJsx(jsx)).ok).toBe(false)
})

test('host components are validated like kernel ones', async () => {
	const result = await compileJsx(`<SecretInput id="service-token" label="Service token" />`, {
		components: { SecretInput: { requiredProps: { id: 'string', label: 'string', env: 'string' } } },
	})

	expect(result.ok).toBe(false)
	if (result.ok) return
	expect(result.error).toBe('Runtime error: SecretInput: required prop `env` must be a string')
})

test('missing required component prop fails before the browser renders', async () => {
	const result = await compilePlan(`<Table columns={["Name"]} rows={[["Canvas"]]} />`)

	expect(result.ok).toBe(false)
	if (result.ok) return
	expect(result.error).toBe('Runtime error: Table: required prop `headers` must be an array')
})

test('component prop validation accepts valid table props', async () => {
	const result = await compilePlan(`<Table headers={["Name"]} rows={[["Canvas"]]} />`)
	expect(result.ok).toBe(true)
})

test('names the files a canvas references as literals, and only those', () => {
	const jsx = `
		<Section title="Files">
			<FilePreview path="/abs/src/auth.ts" lines={[1, 45]} />
			<Markdown file='docs/notes.md' />
			<ImageView src={"/abs/shot.png"} alt="shot" data-src="/not/a/reference.png" />
			<FilePreview path={computed} />
			<Item id="x" label="path=/not/a/reference" />
		</Section>
	`
	expect(canvasFileReferences(jsx).sort()).toEqual(['/abs/shot.png', '/abs/src/auth.ts', 'docs/notes.md'])
})

test('reads a file prop past a > inside another attribute', () => {
	const jsx = `<ImageView alt="a > b" src="/abs/a.png" />
		<FilePreview onClick={() => open()} path="/abs/b.ts" />`
	expect(canvasFileReferences(jsx).sort()).toEqual(['/abs/a.png', '/abs/b.ts'])
})

test('stops an unterminated attribute at the next tag', () => {
	const jsx = `<Note>{'<ImageView'}'s alt</Note>\n<Item label="x" src="/not/named.png" />\n<ImageView src="/abs/c.png" />`
	expect(canvasFileReferences(jsx)).toEqual(['/abs/c.png'])
})

test("reads a host component's file prop only when the host names it", () => {
	const jsx = `<Download path="/abs/report.pdf" label="Report" />`
	expect(canvasFileReferences(jsx)).toEqual([])
	expect(canvasFileReferences(jsx, [['Download', 'path']])).toEqual(['/abs/report.pdf'])
})
