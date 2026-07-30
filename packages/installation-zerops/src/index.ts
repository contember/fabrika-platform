import type { InstallationCli } from '@fabrika/installation-contract'
import { generatedArtifacts } from '../zerops/artifacts'
import { assertArtifactMatchesSchema } from '../zerops/validate'

const USAGE = `Zerops installation

Commands:
  fabrika platform plan --provider=zerops

Real-account init and deploy remain unavailable until the generated installation has been exercised
against a Zerops account.
`

export const installationCli: InstallationCli = {
	provider: 'zerops',
	commands: ['plan'],
	usage: USAGE,
	run: async (command, argv) => {
		if (command !== 'plan') {
			throw new Error(`Zerops installation does not support \`platform ${command}\` yet`)
		}
		if (argv.length > 0) {
			throw new Error(`Unexpected Zerops plan arguments: ${argv.join(' ')}`)
		}
		const artifacts = generatedArtifacts()
		for (const artifact of artifacts) {
			assertArtifactMatchesSchema(artifact)
			console.info(artifact.path)
		}
		console.info(`${artifacts.length} Zerops installation artifact(s) validated`)
	},
}
