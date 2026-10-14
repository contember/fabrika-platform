// The framework's own failures. The envelope of every 5xx is fixed (`dispatch.ts`'s `errorResponse`), and a server
// log names only the fault's reason and its catalog text (`failures.ts`): the message may quote request data.

/** Why the framework failed a request, as a closed catalog with the fixed text a log may print. */
export const SERVER_FAULTS = {
	iam_unavailable: 'IAM could not be reached or could not complete the operation',
	delegation_missing: "a membership endpoint was reached without the proxy's delegation grant",
	iam_answer_mismatch: 'IAM answered for another scope or principal than the request asked for',
	iam_answer_unlabelled: "IAM answered a member without a label where the member directory's dimension shows labels",
	link_mount: 'the endpoint asked for a link of a mount it does not issue',
	directory_unlocated: "no table locates the value of the member directory's dimension that the endpoint's object lies in",
	facility_unbound: 'a facility the endpoint needs (assets, data layer, framework tables or IAM transport) was not bound at boot',
	endpoint_decision_missing: "the request did not carry the proxy's endpoint decision",
	endpoint_decision_mismatch: 'the proxy applied other rules than this version serves the endpoint with',
	key_set_unavailable: 'the IAM key set could not be fetched; nothing was checked',
	output_refused: 'the handler returned a value its output schema refuses',
	contract_inconsistent: 'the compiled endpoint misses what its kind needs (a path parameter, a body limit or a capability kind)',
	webhook_binding_mismatch: "a webhook binding reaches another dimension than the webhook's",
	workload_unauthorized: "the workload's key or token does not carry the authority its declaration needs",
	request_cancelled: 'the request was cancelled or outlived its budget before its transaction committed; nothing it wrote is kept',
	file_object_missing: "a file's object is missing from storage",
	file_object_mismatch: "a file's object has another size than its row records",
	file_key_taken: "a new file's object key already held an object this upload did not write",
	challenge_unavailable: "a form's challenge provider could not be reached in time or did not answer as it documents",
	challenge_misconfigured: "a form's challenge provider refused the application's secret",
	attachment_rows: 'the handler returned more rows than its attachment declares (maxRows)',
	attachment_cell: 'a cell of the attachment is longer than one cell may hold',
	attachment_size: 'the encoded attachment is larger than it declares (maxBytes); no body was sent',
} as const

export type ServerFaultReason = keyof typeof SERVER_FAULTS

/** A failure the framework itself describes. Its message is for the author's own run, never the response or a log. */
export class ServerFault extends Error {
	override readonly name = 'ServerFault'
	readonly reason: ServerFaultReason
	readonly status: number

	constructor(reason: ServerFaultReason, message: string, status = 500) {
		super(message)
		this.reason = reason
		this.status = status
	}
}
