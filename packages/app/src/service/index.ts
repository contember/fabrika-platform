// @fabrika/app/service — the installation's own services only (IAM, Control, Operations). An application serves its
// contract through `serve`; `@fabrika/check` refuses this import in one.

export { dispatchRpcRequest } from '../rpc/dispatcher.js'
export {
	defineServiceContract,
	type ServiceArtifact,
	type ServiceContractBuilder,
	type ServiceContractDeclaration,
	ServiceContractError,
	type ServiceEndpointOptions,
	type ServiceEndpointSpec,
} from './define.js'
export {
	serveService,
	type ServeServiceOptions,
	type ServiceHandler,
	type ServiceHandlers,
	ServiceHandlersError,
	type ServiceRequest,
} from './serve.js'
