// A contract application's container image, rendered from `contractRecipe` as a `Dockerfile`: the build every container
// cloud runs (CodeBuild, ACR Tasks, Cloud Build) and the commands its runtime starts. PURE — no network, no filesystem.
//
// PLATFORM PROTOCOL, like the recipe (ADR-0062): the platform renders its own copy for an application of any release in
// its window. Zerops renders the same recipe into its own descriptor (`@fabrika/provider-zerops`' `execution.ts`).
//
// The file uses no syntax directive and no BuildKit-only form except one secret mount for the source-map bearer, so any
// builder that reads a Dockerfile builds it. Every command goes to `/bin/sh -c` as written: a Dockerfile substitutes no
// variable in `RUN`. Every flag and the form of a `RUN` instruction are the platform's, and a line holds one command, so
// a command is refused when the parser would read more than a shell command out of it: a line break, a trailing
// backslash (the line continues into the next instruction), a heredoc `<<` (its body spans the following lines), a
// first character `-` (BuildKit reads each leading `--word` as an instruction flag: a secret, an ssh or a host network
// mount) or `[` (the JSON exec form).

import { type ContractRecipe, contractRecipe, type ContractRecipeInput } from './build-recipe.js'

/** A base image pinned by its digest: `<name>[:<tag>]@sha256:<64 hex>`. A tag alone moves under a build. */
const PINNED_IMAGE = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?@sha256:[0-9a-f]{64}$/
/** An Alpine package name, as `apk add` takes it. */
const APK_PACKAGE = /^[a-z0-9][a-z0-9.+_-]*$/
/** An absolute path a shell and a Dockerfile both read as one word. */
const ABSOLUTE_PATH = /^\/[A-Za-z0-9._@+/-]*$/
/** A relative path below the source root, the same rule. */
const RELATIVE_PATH = /^[A-Za-z0-9._@+-][A-Za-z0-9._@+/-]*$/
/** A user as `USER` takes it: a name, or a numeric uid and gid. */
const IMAGE_USER = /^(?:[a-z_][a-z0-9_-]{0,31}|[0-9]{1,10}(?::[0-9]{1,10})?)$/

/**
 * The secret id the build reads the source-map bearer from. The builder mounts it for the upload step alone, so no
 * platform step and no layer holds it. That is a guarantee against the platform's own steps, not against the
 * application: its SPA commands and tests run earlier as root and can change what the upload runs (bun's config or
 * cache), as on Zerops, where every build command sees the bearer. The bearer is the application's own upload key.
 */
export const SOURCE_MAP_UPLOAD_SECRET = 'fabrika-source-map-upload-key'

/** The variables `fabrika-source-maps` of `@fabrika/check` reads: the destination and its bearer. */
const SOURCE_MAP_UPLOAD_VARIABLE = 'FABRIKA_SOURCE_MAP_UPLOAD'
const SOURCE_MAP_KEY_VARIABLE = 'FABRIKA_SOURCE_MAP_UPLOAD_KEY'

/** What one contract application's image depends on, besides the recipe's own input. */
export interface ContainerImageInput {
	/**
	 * The recipe's input. `database.schemaChecks` must be `init`: the build's throwaway PostgreSQL refuses to run as root,
	 * and an image build runs as root, so the schema check runs at container start after the migrations.
	 */
	readonly recipe: ContractRecipeInput
	/** The Bun image both stages start from, pinned by digest. Its Bun is the one the platform builds with. */
	readonly baseImage: string
	/** The authored SPA commands, each one line, run in the source root before the recipe's build. */
	readonly spaCommands: readonly string[]
	/** Alpine packages the runtime stage installs (a scanner, its signatures' updater). */
	readonly runtimePackages: readonly string[]
	/**
	 * Files the runtime stage carries besides the build (a database's CA bundle), each at an absolute path outside the
	 * runtime root, written line by line.
	 */
	readonly runtimeFiles: readonly { readonly path: string; readonly lines: readonly string[] }[]
	/**
	 * The source-map upload's destination, a value with no credential (`FABRIKA_SOURCE_MAP_UPLOAD`), when the recipe
	 * uploads them. The bearer comes from the builder's secret `SOURCE_MAP_UPLOAD_SECRET`, never from this file.
	 */
	readonly sourceMapUpload: string | null
	/** The user the runtime stage runs as. Not root: the application writes nothing in its own tree. */
	readonly runtimeUser: string
}

/** The rendered image and how a provider runs it. */
export interface ContainerImage {
	/**
	 * The `Dockerfile` text. Its build context is the `git archive` of the commit Control uploaded and nothing else: both
	 * stages copy the whole context, and a checkout's `.git/config` can hold a clone URL with a token.
	 */
	readonly dockerfile: string
	/** Each command the provider runs once before the new version serves (its migration step), as argv, in order. */
	readonly init: readonly (readonly string[])[]
	/** The container's command, as argv; the image's `CMD` too. */
	readonly start: readonly string[]
	/** The recipe the image was rendered from: its `jobs` are the provider's to schedule, the image runs none. */
	readonly recipe: ContractRecipe
}

/** One argument a POSIX shell reads as exactly `value`. */
const shellQuoted = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`

/** A value that may hold no line break: a Dockerfile line ends there. */
const oneLine = (value: string, what: string): string => {
	if (/[\r\n]/.test(value)) throw new Error(`${what} must be one line`)
	// A trailing backslash continues a Dockerfile line into the next instruction.
	if (value.endsWith('\\')) throw new Error(`${what} must not end with a backslash`)
	return value
}

/** `RUN` lines that write `lines` to `path` (relative to the working directory, or absolute). */
const writeFile = (path: string, lines: readonly string[]): string => {
	const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
	const write = `printf '%s\\n' ${lines.map((line) => shellQuoted(oneLine(line, 'a generated file line'))).join(' ')} > ${path}`
	return `RUN ${parent === '' ? '' : `mkdir -p ${parent} && `}${write}`
}

/** One build command as one `RUN`, which hands it to `/bin/sh -c` as written; `mounts` are the platform's own flags. */
const runCommand = (command: string, mounts = ''): string => {
	const line = oneLine(command, 'a build command')
	if (/^\s*[-[]/.test(line)) throw new Error('a build command must not start with `-` or `[`: RUN would read it as its own flag or form')
	if (line.includes('<<')) throw new Error('a build command must not hold a heredoc (`<<`): its body would span the following lines')
	return `RUN ${mounts}${line}`
}

/**
 * The recipe's source-map step, with the destination as a literal and the bearer read from the mounted secret. Both are
 * exported, because the step is a list (`cd /tmp && …`) and a prefix assignment would reach its first command only. A
 * missing secret leaves the bearer empty, and the step, which never fails the build, reports the maps as not uploaded.
 */
const sourceMapCommand = (command: string, destination: string): string => {
	const secret = `/run/secrets/${SOURCE_MAP_UPLOAD_SECRET}`
	const mount = `--mount=type=secret,id=${SOURCE_MAP_UPLOAD_SECRET} `
	const destinationValue = shellQuoted(oneLine(destination, 'the source-map destination'))
	return runCommand(
		`export ${SOURCE_MAP_UPLOAD_VARIABLE}=${destinationValue} ${SOURCE_MAP_KEY_VARIABLE}="$(cat ${secret} 2>/dev/null)" && ${command}`,
		mount,
	)
}

/**
 * The image of one contract application: a build stage that runs the SPA commands and then the recipe's build in the
 * source root, and a runtime stage that carries the built tree at the runtime root and starts the recipe's start script.
 * The migration step is the provider's: `init` names the commands, and the image runs none of them by itself.
 */
export function containerImage(input: ContainerImageInput): ContainerImage {
	const { recipe: recipeInput } = input
	if (recipeInput.database !== false && recipeInput.database.schemaChecks !== 'init') {
		throw new Error("an image build runs as root, where the build's throwaway PostgreSQL does not start: use schemaChecks 'init'")
	}
	if (!PINNED_IMAGE.test(input.baseImage)) throw new Error('the base image must be pinned by its digest: <name>[:<tag>]@sha256:<64 hex>')
	// `USER` reads the uid as a number, so `00` and `000:1000` are root too.
	if (!IMAGE_USER.test(input.runtimeUser) || input.runtimeUser === 'root' || /^0+(?::|$)/.test(input.runtimeUser)) {
		throw new Error('the runtime user must be a user name or a numeric uid, and not root')
	}
	if ((input.sourceMapUpload !== null) !== recipeInput.sourceMaps) {
		throw new Error('a source-map destination is given exactly when the recipe uploads source maps')
	}
	for (const name of input.runtimePackages) {
		if (!APK_PACKAGE.test(name)) throw new Error(`the runtime package ${JSON.stringify(name)} is not an Alpine package name`)
	}
	if (recipeInput.scan) {
		// The scan refuses signatures older than three days, and an image's are as old as its build: a provider that scans
		// must refresh them at start and daily, as Zerops does with freshclam. Until one does, a scanning kind fails closed.
		throw new Error('a contract that scans its files needs a signature refresh no container provider supplies yet')
	}
	const { sourceRoot, runtimeRoot } = recipeInput
	// Both go into WORKDIR, COPY and every generated script's `cd`; `/` would copy the whole build filesystem.
	for (const root of [sourceRoot, runtimeRoot]) {
		if (!ABSOLUTE_PATH.test(root) || root === '/' || root.split('/').includes('..')) {
			throw new Error(`the root ${JSON.stringify(root)} must be an absolute directory below / that a shell reads as one word`)
		}
	}
	for (const file of input.runtimeFiles) {
		if (!ABSOLUTE_PATH.test(file.path) || file.path.split('/').includes('..')) {
			throw new Error(`the runtime file ${JSON.stringify(file.path)} must be an absolute path a shell reads as one word`)
		}
		if (file.path === runtimeRoot || file.path.startsWith(`${runtimeRoot}/`)) {
			throw new Error(`the runtime file ${file.path} must lie outside the runtime root, which the build fills`)
		}
	}
	const recipe = contractRecipe(recipeInput)
	// The recipe uploads the maps in its last step, after every check (`contractRecipe`).
	const sourceMapStep = recipeInput.sourceMaps ? recipe.build.at(-1) : undefined
	if (sourceMapStep !== undefined && !('run' in sourceMapStep && sourceMapStep.run.includes('fabrika-source-maps'))) {
		throw new Error("the recipe's last build step is not its source-map upload")
	}

	const build = recipe.build.map((step) => {
		if ('write' in step) {
			if (!RELATIVE_PATH.test(step.write) || step.write.split('/').includes('..')) {
				throw new Error(`the generated file ${step.write} is not a plain relative path`)
			}
			return writeFile(step.write, step.lines)
		}
		if (step === sourceMapStep && input.sourceMapUpload !== null) return sourceMapCommand(step.run, input.sourceMapUpload)
		return runCommand(step.run)
	})
	const dockerfile = [
		'# Generated by the platform from the contract recipe of @fabrika/app/build. Do not edit: every deploy renders it.',
		`FROM ${input.baseImage} AS build`,
		'USER root',
		`WORKDIR ${sourceRoot}`,
		'COPY . .',
		...input.spaCommands.map((command) => runCommand(oneLine(command, 'an SPA command'))),
		...build,
		'',
		`FROM ${input.baseImage} AS runtime`,
		'USER root',
		...(input.runtimePackages.length === 0 ? [] : [`RUN apk add --no-cache ${[...new Set(input.runtimePackages)].sort().join(' ')}`]),
		...input.runtimeFiles.map((file) => writeFile(file.path, file.lines)),
		`COPY --from=build ${sourceRoot} ${runtimeRoot}`,
		`WORKDIR ${runtimeRoot}`,
		`USER ${input.runtimeUser}`,
		`CMD ${JSON.stringify(['sh', `${runtimeRoot}/${recipe.start}`])}`,
		'',
	].join('\n')
	return {
		dockerfile,
		init: recipe.init.map((path) => ['sh', `${runtimeRoot}/${path}`]),
		start: ['sh', `${runtimeRoot}/${recipe.start}`],
		recipe,
	}
}
