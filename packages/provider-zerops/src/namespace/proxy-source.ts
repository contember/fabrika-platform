import { prepareZeropsDescriptor } from '../descriptor'
import { verifyZeropsArtifactSourceDescriptor, ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES } from '../manifest'
import { commitSha, exactKeys, record, repository, sha256 } from '../source/validation'
import type { ZeropsNamespaceProxySource } from './types'

export const decodeZeropsNamespaceProxySource = (value: unknown): ZeropsNamespaceProxySource => {
	const raw = record(value, 'Zerops namespace proxy source')
	exactKeys(raw, ['repository', 'commitSha', 'descriptor'], 'Zerops namespace proxy source')
	const { repository: repositoryValue, commitSha: commitValue, descriptor: descriptorValue } = raw
	const descriptor = record(descriptorValue, 'proxy descriptor')
	exactKeys(descriptor, ['path', 'contents', 'sha256'], 'proxy descriptor')
	const { path, contents, sha256: digest } = descriptor
	if (
		path !== 'zerops.yaml' || typeof contents !== 'string' || contents === ''
		|| new TextEncoder().encode(contents).byteLength > ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES
	) {
		throw new Error('Invalid Zerops namespace proxy descriptor')
	}
	prepareZeropsDescriptor(contents, 'proxy')
	return {
		repository: repository(repositoryValue, 'proxy repository'),
		commitSha: commitSha(commitValue, 'proxy commit'),
		descriptor: { path: 'zerops.yaml', contents, sha256: sha256(digest, 'proxy descriptor digest') },
	}
}

export const verifyZeropsNamespaceProxySource = async (source: ZeropsNamespaceProxySource): Promise<void> => {
	const parsed = decodeZeropsNamespaceProxySource(source)
	await verifyZeropsArtifactSourceDescriptor(parsed.descriptor)
}

export const equalProxySources = (left: ZeropsNamespaceProxySource, right: ZeropsNamespaceProxySource): boolean =>
	left.repository.owner === right.repository.owner && left.repository.name === right.repository.name
	&& left.commitSha === right.commitSha && left.descriptor.path === right.descriptor.path
	&& left.descriptor.contents === right.descriptor.contents && left.descriptor.sha256 === right.descriptor.sha256
