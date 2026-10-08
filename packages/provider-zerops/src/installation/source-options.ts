export const readInstallationSourceDir = (argv: readonly string[], env: Record<string, string | undefined>): string => {
	if (argv.some((arg) => arg === '--from-git' || arg.startsWith('--from-git=')) || env['FABRIKA_ZEROPS_BUILD_FROM_GIT'] !== undefined) {
		throw new Error(
			'Mutable installation Git sources are refused. Remove --from-git and unset FABRIKA_ZEROPS_BUILD_FROM_GIT; run the CLI from a clean full checkout with --source-dir=<checkout>.',
		)
	}
	const values = argv.filter((arg) => arg.startsWith('--source-dir='))
	if (values.length > 1) throw new Error('--source-dir was given more than once')
	const value = values[0]?.slice('--source-dir='.length).trim()
	if (!value) throw new Error('--source-dir=<checkout> is required; run the CLI from that clean full checkout')
	return value
}
