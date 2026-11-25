// @fabrika/provider-aws: the AWS provider bundle (ECS on Fargate), under construction. This release holds the
// authoring config and the codecs of what Control persists; the clients, the build and the deploy follow
// (docs/ideas/aws-provider.md, "The checklist"). The package stays private until it can deploy.

export { type AwsAppConfig, type AwsAuthoredAppConfig, defineApp, isAwsAppConfig } from './authoring'
export {
	AWS_PROVIDER,
	type AwsAppArtifact,
	awsAppArtifactCodec,
	type AwsAppTarget,
	awsAppTargetCodec,
	type AwsNamespaceSizing,
	type AwsNamespaceTarget,
	awsNamespaceTargetCodec,
	type AwsRunCheckpoint,
	awsRunCheckpointCodec,
} from './codecs'
export {
	AWS_KEPT_IMAGES,
	AWS_KEPT_SECRET_RUNS,
	AWS_TASK_CPU,
	AWS_TASK_MEMORY,
	type AwsControlClients,
	type AwsControlProviderOptions,
	type AwsEnvironmentResources,
	awsEnvironmentResources,
	type AwsExpiringCredentialSource,
	awsSecretParameter,
	type AwsSourcePort,
	type AwsSourceRepository,
	awsSourceRepository,
	awsTaskValues,
	createAwsControlProvider,
} from './control'
export {
	AWS_BUILD_IMAGE,
	AWS_LOG_RETENTION_DAYS,
	awsAppsPermissionsBoundary,
	type AwsEnvironmentStack,
	awsEnvironmentStack,
	type AwsEnvironmentStackOutputs,
	type AwsInstallationNetwork,
	checkInstallationNetwork,
	ensureEnvironmentStack,
	type EnsureEnvironmentStackInput,
} from './environment-stack'
export {
	AWS_CHEAP_PRESET,
	awsNamespaceCapabilities,
	type AwsNamespaceOutputs,
	type AwsNamespaceResources,
	awsNamespaceResources,
	awsNamespaceStack,
} from './namespace'
export { AWS_STACK_POLL_MS, AWS_STACK_TIMEOUT_MS, type AwsStack, ensureStack, type EnsureStackInput } from './stack'
