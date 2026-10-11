// Evaluates a paired fixture as Bun does and prints its canonical artifact, or what evaluating it threw. Plain
// JavaScript on purpose: the module it imports is whatever the fixture evaluates to, which no static type describes.
// A second argument names the module whose `tables` the contract compiles against.
import { compileContract } from '@fabrika/app/contract'
import { canonicalArtifactJson } from '@fabrika/auth-core'

const [entry, tablesEntry] = process.argv.slice(2)
try {
	const module = await import(entry)
	const tables = tablesEntry === undefined ? {} : (await import(tablesEntry)).tables
	console.log(JSON.stringify({ ok: true, json: canonicalArtifactJson(compileContract(module.contract, tables)) }))
} catch (error) {
	console.log(JSON.stringify({ ok: false, error: error instanceof Error ? `${error.name}: ${error.message.split('\n')[0]}` : String(error) }))
}
