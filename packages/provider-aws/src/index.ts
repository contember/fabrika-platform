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
