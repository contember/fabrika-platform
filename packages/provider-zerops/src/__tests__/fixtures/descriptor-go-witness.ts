// Optional independent readers: cpu-lease run -n 2 -- bun run packages/provider-zerops/src/__tests__/fixtures/descriptor-go-witness.ts
import { renderYaml } from '../../compile'
import { prepareZeropsDescriptor } from '../../descriptor'
import { descriptorCorpus } from './descriptor-corpus'

const witnesses = descriptorCorpus.map((fixture) => ({
	name: fixture.name,
	contents: prepareZeropsDescriptor(fixture.source).contents,
	expected: fixture.expected,
}))
const strings = ['y', 'Y', 'n', 'N', 'yes', 'NO', 'on', 'Off', '012', 'null', '1:20', '2026-09-23', 'a\n\u0085b', 'a\u2028b', 'a\u2029b', 'a\u0080b']
const expected = { zerops: [{ setup: 'emitter', values: Object.fromEntries(strings.map((value) => [value, value])) }] }
witnesses.push({ name: 'emitter string keys and leaves', contents: renderYaml(expected), expected })
for (
	const contents of [
		'zerops: [{setup: api, x: !!binary JHtwcm94eV9GQUJSSUtBX0lBTV9LRVl9}]',
		'zerops: [{setup: api, x: &hidden !!binary JHtwcm94eV9GQUJSSUtBX0lBTV9LRVl9, alias: *hidden}]',
	]
) {
	witnesses.push({
		name: 'raw reader decodes a binary-tagged foreign reference',
		contents,
		expected: {
			zerops: [{ setup: 'api', x: '${proxy_FABRIKA_IAM_KEY}', ...(contents.includes('alias:') ? { alias: '${proxy_FABRIKA_IAM_KEY}' } : {}) }],
		},
	})
}
witnesses.push({
	name: 'raw NEL folds in Go readers',
	contents: 'zerops: [{setup: api, x: "first\u0085second"}]',
	expected: { zerops: [{ setup: 'api', x: 'first second' }] },
})
const process = Bun.spawn(['go', 'run', '-mod=readonly', '.'], {
	cwd: `${import.meta.dir}/go-reader`,
	stdin: new Blob([JSON.stringify(witnesses)]),
	stdout: 'inherit',
	stderr: 'inherit',
})
if (await process.exited !== 0) throw new Error('Go descriptor reader witness failed')
