// One repository-root `zerops.yaml` per refusal of a contract application's setup (ADR-0043). Each is otherwise the
// allowed form: a setup with the SPA build.

export interface LockedRepository {
	readonly name: string
	readonly zeropsYaml: string
	/** The key the one-line refusal names. */
	readonly refused: string
}

const setup = (extra: string): string =>
	['zerops:', '  - setup: notesapi', '    build:', '      base: [alpine/bun@1.3]', '      buildCommands: ["bun run build:spa"]', extra, ''].join('\n')

export const LOCKED_REPOSITORIES: readonly LockedRepository[] = [
	{ name: 'a hand-written start command', zeropsYaml: setup('    run:\n      start: bun src/server.ts'), refused: 'run.start' },
	{ name: 'skipped migrations', zeropsYaml: setup('    run:\n      initCommands: ["true"]'), refused: 'run.initCommands' },
	{ name: 'an authored crontab', zeropsYaml: setup('    run:\n      crontab: []'), refused: 'run.crontab' },
	{ name: 'an empty run section', zeropsYaml: setup('    run: {}'), refused: 'run' },
	{ name: 'files copied into the runtime image', zeropsYaml: setup('      addToRunPrepare: [src]'), refused: 'build.addToRunPrepare' },
	{ name: 'its own deploy files', zeropsYaml: setup('      deployFiles: [./]'), refused: 'build.deployFiles' },
	{ name: 'the deploy list of the published schema', zeropsYaml: setup('      deploy: [./]'), refused: 'build.deploy' },
	{ name: 'a build-image command', zeropsYaml: setup('      prepareCommands: ["apk add curl"]'), refused: 'build.prepareCommands' },
	{ name: 'a build cache', zeropsYaml: setup('      cache: [node_modules]'), refused: 'build.cache' },
	{ name: 'a build variable', zeropsYaml: setup('      envVariables:\n        NODE_OPTIONS: "--require ./hook.cjs"'), refused: 'build.envVariables' },
	{ name: 'a shutdown before the switch', zeropsYaml: setup('    deploy:\n      temporaryShutdown: true'), refused: 'deploy.temporaryShutdown' },
	{
		name: 'its own readiness check',
		zeropsYaml: setup('    deploy:\n      readinessCheck:\n        exec:\n          command: "true"'),
		refused: 'deploy.readinessCheck',
	},
	{ name: 'an inherited setup', zeropsYaml: setup('    extends: base'), refused: 'extends' },
]
