// The ECR calls the AWS provider makes (ADR-0081): a repository per application environment, created on first use and
// kept by name; a lifecycle policy that expires old images; and the lookup of an image the build pushed, by digest or
// tag. The task definition names an image by digest, never by tag, so a lookup answers the digest.
//
// UNVERIFIED: the operations' input and answer fields follow ECR's API reference; none was checked against an account.

import { z } from 'zod'
import { AwsError, type AwsJsonClient } from './json'

/** A repository's name: lowercase segments separated by `/`, each joined by `.`, `_` or `-`, at most 256. */
const REPOSITORY_NAME = /^(?=.{2,256}$)(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*$/
/** An image digest as ECR records it. */
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/
/** An image tag. */
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
/** A resource tag's key and value, as AWS bounds them: letters, digits, space separators and `_.:/=+-@`, no line break. */
const TAG_KEY = /^[\p{L}\p{Z}\p{N}_.:/=+@-]{1,128}$/u
const TAG_VALUE = /^[\p{L}\p{Z}\p{N}_.:/=+@-]{0,256}$/u
/** The most images a lifecycle policy keeps. */
export const MAX_KEPT_IMAGES = 1000

/** A repository: its name, the URI an image reference starts with, and its ARN. */
export interface EcrRepository {
	readonly name: string
	readonly uri: string
	readonly arn: string
}

/** An image in a repository: its digest, its tags, and when it was pushed. */
export interface EcrImage {
	readonly digest: string
	readonly tags: readonly string[]
	readonly pushedAt: Date
}

/** Which image a lookup names. */
export type EcrImageReference = { readonly digest: string } | { readonly tag: string }

export interface EcrClient {
	/** The repository `name`, created with `tags` when it does not exist; an existing one is answered as it is. */
	ensureRepository(name: string, tags: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<EcrRepository>
	/** Keeps the newest `keep` images of `name` and expires the rest, replacing any earlier policy. */
	keepNewestImages(name: string, keep: number, signal?: AbortSignal): Promise<void>
	/** The image `reference` names in `name`, or `null` when there is none. */
	findImage(name: string, reference: EcrImageReference, signal?: AbortSignal): Promise<EcrImage | null>
}

const repositorySchema = z.object({ repositoryName: z.string(), repositoryUri: z.string(), repositoryArn: z.string() })
const createdSchema = z.object({ repository: repositorySchema })
const describedSchema = z.object({ repositories: z.array(repositorySchema) })
const imagesSchema = z.object({
	imageDetails: z.array(
		z.object({ imageDigest: z.string().regex(IMAGE_DIGEST), imageTags: z.array(z.string()).optional(), imagePushedAt: z.number() }),
	),
})
const policySchema = z.object({})

/** Refuses a value of another form before anything is sent, naming the argument only. */
function refuse(what: string): never {
	throw new Error(`ECR: ${what} is not one ECR takes`)
}

function repositoryName(name: string): string {
	return REPOSITORY_NAME.test(name) ? name : refuse('the repository name')
}

function repositoryOf(raw: z.infer<typeof repositorySchema>): EcrRepository {
	return { name: raw.repositoryName, uri: raw.repositoryUri, arn: raw.repositoryArn }
}

/** ECR over `json`, a client of the `ECR` service. */
export function ecrClient(json: AwsJsonClient): EcrClient {
	return {
		async ensureRepository(name, tags, signal) {
			const repository = repositoryName(name)
			const tagList = Object.entries(tags).map(([key, value]) => {
				if (!TAG_KEY.test(key) || !TAG_VALUE.test(value) || key.startsWith('aws:')) refuse('a tag')
				return { Key: key, Value: value }
			})
			try {
				const created = await json.call(
					'CreateRepository',
					{
						repositoryName: repository,
						imageTagMutability: 'IMMUTABLE',
						imageScanningConfiguration: { scanOnPush: false },
						encryptionConfiguration: { encryptionType: 'AES256' },
						tags: tagList,
					},
					createdSchema,
					signal,
				)
				return repositoryOf(created.repository)
			} catch (error) {
				if (!(error instanceof AwsError) || error.code !== 'RepositoryAlreadyExistsException') throw error
			}
			const described = await json.call('DescribeRepositories', { repositoryNames: [repository] }, describedSchema, signal)
			const [found] = described.repositories
			if (found === undefined || found.repositoryName !== repository) throw new AwsError('DescribeRepositories', 'invalid_answer', 200, null, false)
			return repositoryOf(found)
		},

		async keepNewestImages(name, keep, signal) {
			const repository = repositoryName(name)
			if (!Number.isInteger(keep) || keep < 1 || keep > MAX_KEPT_IMAGES) refuse('the number of images to keep')
			const policy = {
				rules: [
					{
						rulePriority: 1,
						description: `Keep the newest ${keep} images`,
						selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: keep },
						action: { type: 'expire' },
					},
				],
			}
			await json.call('PutLifecyclePolicy', { repositoryName: repository, lifecyclePolicyText: JSON.stringify(policy) }, policySchema, signal)
		},

		async findImage(name, reference, signal) {
			const repository = repositoryName(name)
			const imageId = 'digest' in reference
				? IMAGE_DIGEST.test(reference.digest) ? { imageDigest: reference.digest } : refuse('the image digest')
				: IMAGE_TAG.test(reference.tag)
				? { imageTag: reference.tag }
				: refuse('the image tag')
			let answer: z.infer<typeof imagesSchema>
			try {
				answer = await json.call('DescribeImages', { repositoryName: repository, imageIds: [imageId] }, imagesSchema, signal)
			} catch (error) {
				if (error instanceof AwsError && error.code === 'ImageNotFoundException') return null
				throw error
			}
			const [image] = answer.imageDetails
			if (image === undefined) return null
			// ECR's JSON protocol writes a timestamp as seconds since the epoch, fractions included.
			return { digest: image.imageDigest, tags: image.imageTags ?? [], pushedAt: new Date(image.imagePushedAt * 1000) }
		},
	}
}
