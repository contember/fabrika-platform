import type { JsonValue } from '@fabrika/provider-contract'

export interface DescriptorCase {
	name: string
	source: string
	expected: { readonly [key: string]: JsonValue }
}

export const descriptorCorpus: readonly DescriptorCase[] = [
	...['fffe', 'ffff'].map((code): DescriptorCase => {
		const character = String.fromCodePoint(Number.parseInt(code, 16))
		return {
			name: `escaped U+${code.toUpperCase()} in keys and string leaves`,
			source: `zerops: [{setup: api, extra: {"\\u${code}": "a\\u${code}b", multiline: "first\\nsecond\\u${code}line"}}]`,
			expected: { zerops: [{ setup: 'api', extra: { [character]: `a${character}b`, multiline: `first\nsecond${character}line` } }] },
		}
	}),
	{
		name: 'flow, comments, CRLF and quoted legacy scalars',
		source: '# source\r\nzerops: [{setup: api, extra: {"y": "n", yesValue: "yes", octal: "012"}}]\r\n',
		expected: { zerops: [{ setup: 'api', extra: { y: 'n', yesValue: 'yes', octal: '012' } }] },
	},
	{
		name: 'folded and literal strings',
		source:
			'zerops:\n  - setup: api\n    run:\n      start: >-\n        bun run\n        start\n      envVariables:\n        TEXT: |\n          first\n          second\n',
		expected: { zerops: [{ setup: 'api', run: { start: 'bun run start', envVariables: { TEXT: 'first\nsecond\n' } } }] },
	},
	{
		name: 'escaped separators, controls and dollar sign',
		source: 'zerops: [{setup: api, extra: {"\\u0085": "a\\u0080\\u0085\\u009f\\u2028\\u2029b", ref: "\\x24{api_HOST}"}}]',
		expected: { zerops: [{ setup: 'api', extra: { '\u0085': 'a\u0080\u0085\u009f\u2028\u2029b', ref: '${api_HOST}' } }] },
	},
	{
		name: 'ordinary unknown fields and exact numbers',
		source: 'zerops: [{setup: api, future: [null, true, false, 42, 1.25, 1.25e+2, 0.0000001, 0.1, 9007199254740991], __proto__: {constructor: safe}}]',
		expected: {
			zerops: [{ setup: 'api', future: [null, true, false, 42, 1.25, 125, 0.0000001, 0.1, 9007199254740991], ['__proto__']: { constructor: 'safe' } }],
		},
	},
]

export const rejectedDescriptorCorpus: readonly [string, string][] = [
	['binary tag', 'zerops: [{setup: api, x: !!binary JHtwcm94eV9GQUJSSUtBX0lBTV9LRVl9}]'],
	['binary alias', 'x: &hidden !!binary JHtwcm94eV9GQUJSSUtBX0lBTV9LRVl9\nzerops: [{setup: api, x: *hidden}]'],
	['standard string tag', 'zerops: [{setup: api, x: !!str safe}]'],
	['standard map tag', 'zerops: [!!map {setup: api}]'],
	['local tag', 'zerops: [{setup: api, x: !custom safe}]'],
	['bare tag', 'zerops: [{setup: api, x: ! safe}]'],
	['escaped lone surrogate', 'zerops: [{setup: api, x: "\\uD800"}]'],
	['unused anchor', 'zerops: [{setup: api, x: &unused safe}]'],
	['alias cycle', 'zerops: &cycle [{setup: api, x: *cycle}]'],
	['merge key', 'zerops: [{setup: api, <<: {x: safe}}]'],
	['duplicate key', 'zerops: [{setup: api, x: safe, x: unsafe}]'],
	['decoded duplicate key', 'zerops: [{setup: api, "x": safe, "\\x78": unsafe}]'],
	['numeric key', 'zerops: [{setup: api, 12: value}]'],
	['complex key', 'zerops: [{setup: api, ? [x, y]: value}]'],
	['multiple documents', 'zerops: [{setup: api}]\n---\nzerops: [{setup: other}]'],
	['sequence root', '[{setup: api}]'],
	['empty sequence', 'zerops: []'],
	['mapping instead of sequence', 'zerops: {setup: api}'],
	['duplicate setup', 'zerops: [{setup: api}, {setup: api}]'],
	['missing setup', 'zerops: [{run: {start: hello}}]'],
	['nonstring setup', 'zerops: [{setup: 42}]'],
	['empty setup', 'zerops: [{setup: " "}]'],
	['invalid run', 'zerops: [{setup: api, run: []}]'],
	['scalar env map', 'zerops: [{setup: api, run: {envVariables: secret}}]'],
	['array env map', 'zerops: [{setup: api, run: {envVariables: [a, b]}}]'],
	['nested env value', 'zerops: [{setup: api, run: {envVariables: {KEY: {nested: value}}}}]'],
	['nonstring env value', 'zerops: [{setup: api, run: {envVariables: {KEY: true}}}]'],
	['warning', '%YAML 1.3\n---\nzerops: [{setup: api}]'],
	...['012', 'yes', 'y', 'n', 'ON', '1:20', '2026-09-23', '.inf', '.nan', '9007199254740993', '1.0000000000000001', '1e-999'].map(
		(value): [string, string] => [`plain ${value}`, `zerops: [{setup: api, x: ${value}}]`],
	),
	...['\u0080', '\u0085', '\u009f', '\u2028', '\u2029', '\ufffe', '\uffff'].map(
		(value): [string, string] => [`raw control ${value.codePointAt(0)}`, `zerops: [{setup: api, x: "a${value}b"}]`],
	),
]
