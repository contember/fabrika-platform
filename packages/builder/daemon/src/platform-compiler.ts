import { compileFabrikaManifest, createZeropsArtifactSourceDescriptor, isZeropsAppConfig } from '@fabrika/provider-zerops'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// This entry point is executed only in the credential-free child process.
async function compile(): Promise<void> {
	const env = process.argv[2]
	const output = process.argv[3]
	if (!env || !output) throw new Error('Missing compiler arguments')
	const module: unknown = await import(pathToFileURL(join(process.cwd(), 'fabrika.config.ts')).href)
	const config: unknown = typeof module === 'object' && module !== null ? Reflect.get(module, 'default') : undefined
	if (!isZeropsAppConfig(config)) throw new Error('Unsupported project config')
	const source = await createZeropsArtifactSourceDescriptor(await Bun.file('zerops.yaml').text())
	await Bun.write(output, JSON.stringify(compileFabrikaManifest(config, env, source)))
}

if (import.meta.main) {
	await compile().catch(() => {
		process.exitCode = 1
	})
}
