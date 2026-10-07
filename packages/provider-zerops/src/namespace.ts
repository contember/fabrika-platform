export { zeropsNamespaceTargetCodec } from './namespace/codec'
export {
	ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE,
	ZEROPS_NAMESPACE_IAM_KEY_VARIABLE,
	ZEROPS_NAMESPACE_POSTGRES_HOSTNAME,
	ZEROPS_NAMESPACE_PROXY_HOSTNAME,
	ZEROPS_NAMESPACE_SUBDOMAIN_VARIABLE,
	ZEROPS_SHARED_POSTGRES_CONNECTION_STRING,
} from './namespace/constants'
export {
	ZEROPS_NAMESPACE_CANCELLED,
	ZEROPS_NAMESPACE_LIFECYCLE,
	ZEROPS_PROXY_DEPLOY_FAILED,
	ZEROPS_PROXY_DEPLOY_TIMEOUT,
	ZEROPS_SUBDOMAIN_NOT_PUBLISHED,
} from './namespace/errors'
export { createZeropsNamespaceOperator } from './namespace/operator'
export { createZeropsNamespaceCapabilities } from './namespace/provisioning'
export { republishProxy, type ZeropsProxyApi, type ZeropsProxyRepublishInput } from './namespace/proxy-attempt'
export { decodeZeropsNamespaceProxySource, verifyZeropsNamespaceProxySource } from './namespace/proxy-source'
export { compileZeropsNamespaceTopology, zeropsNamespacePreset } from './namespace/topology'
export type {
	ZeropsNamespaceOperatorOptions,
	ZeropsNamespaceOptions,
	ZeropsNamespacePlanOptions,
	ZeropsNamespacePostgres,
	ZeropsNamespacePresetInput,
	ZeropsNamespaceProxyBuild,
	ZeropsNamespaceProxyDeployment,
	ZeropsNamespaceProxySource,
	ZeropsNamespacePublicAccess,
	ZeropsNamespaceTarget,
	ZeropsNamespaceTopology,
} from './namespace/types'
