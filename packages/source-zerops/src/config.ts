import { GitHubAppClient, type GitHubAppFetch } from '@fabrika/github-app'
import { GitHubMetadataClient, type GitHubMetadataFetch } from './github-metadata'
import { GitRepositorySource, type RepositorySource } from './repository'
import { type SourceUploadFetch, ZeropsSourceService } from './service'

const DEFAULT_PORT = 8080

export interface SourceEnvironment {
	readonly [name: string]: string | undefined
}

export interface SourceRuntimeOptions {
	env?: SourceEnvironment
	githubFetch?: GitHubAppFetch
	metadataFetch?: GitHubMetadataFetch
	uploadFetch?: SourceUploadFetch
	repository?: RepositorySource
}

export interface SourceRuntime {
	port: number
	githubEnabled: boolean
	service: ZeropsSourceService
}

/** Assemble the credential-owning runtime and import its private key before listening. */
export async function createSourceRuntime(
	options: SourceRuntimeOptions = {},
): Promise<SourceRuntime> {
	const env = options.env ?? process.env
	const rpcKey = required(env, 'FABRIKA_SOURCE_RPC_KEY')
	const appId = optional(env, 'GITHUB_APP_ID')
	const privateKeyPem = optional(env, 'GITHUB_APP_PRIVATE_KEY')
	if ((appId === undefined) !== (privateKeyPem === undefined)) {
		throw new Error('GitHub App configuration is incomplete')
	}
	const github = appId === undefined || privateKeyPem === undefined
		? undefined
		: await GitHubAppClient.create({
			appId,
			privateKeyPem,
			...(options.githubFetch === undefined
				? {}
				: { fetch: options.githubFetch }),
		})
	const repository = options.repository
		?? new GitRepositorySource({
			...(github === undefined ? {} : { github }),
			metadata: new GitHubMetadataClient({
				...(options.metadataFetch === undefined ? {} : { fetch: options.metadataFetch }),
			}),
		})
	const service = new ZeropsSourceService({
		rpcKey,
		repository,
		...(github === undefined ? {} : { github }),
		...(options.uploadFetch === undefined
			? {}
			: { uploadFetch: options.uploadFetch }),
	})
	return {
		port: parsePort(optional(env, 'PORT')),
		githubEnabled: github !== undefined,
		service,
	}
}

function required(env: SourceEnvironment, name: string): string {
	const value = optional(env, name)
	if (value === undefined) throw new Error(`${name} is required`)
	return value
}

function optional(env: SourceEnvironment, name: string): string | undefined {
	const value = env[name]
	return value === undefined || value.length === 0 ? undefined : value
}

function parsePort(value: string | undefined): number {
	if (value === undefined) return DEFAULT_PORT
	if (!/^[1-9][0-9]{0,4}$/.test(value)) throw new Error('PORT is invalid')
	const port = Number(value)
	if (!Number.isSafeInteger(port) || port > 65_535) {
		throw new Error('PORT is invalid')
	}
	return port
}
