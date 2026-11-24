# @fabrika/provider-aws

The AWS provider bundle, on ECS with Fargate, under construction ([the AWS idea](../../docs/ideas/aws-provider.md),
"The checklist"). Assumes the root CLAUDE.md. **Private until it can deploy**: no release publishes it, and nothing an
installation runs imports it.

```bash
bun run typecheck
bun test
```

| Module         | What it owns                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codecs.ts`    | `AWS_PROVIDER` and what Control persists: the app target (account, region, cluster, service), the artifact (the contract's digest and health path), the namespace target (its stack and sizing), the run checkpoint (`buildToken`, `buildId`, `taskDefinitionArn`, `serviceUpdateRequested`, `deploymentArn`).                                                                                                                                        |
| `authoring.ts` | `defineApp({ id })` and `isAwsAppConfig`: the config `authoredAppProvider` reads as `aws`, under the contract's app id rule.                                                                                                                                                                                                                                                                                                                          |
| `aws/sigv4.ts` | `signRequest`: Signature Version 4 header signing for the package's clients, over Web Crypto. It refuses what it would have to encode or normalize (a path outside the unreserved characters), a repeated header, a line break, a header it sets itself, and an `http:` origin without `allowInsecureOrigin`.                                                                                                                                         |
| `aws/json.ts`  | `awsJsonClient(service, options)`: one signed `POST /` per call of AWS's JSON protocol (`ECS`, `CODEBUILD`, `ECR`, `SSM`, `LOGS`), credentials read per call from `{ current() }` (platform-node's `CredentialProvider`), no redirect followed, the answer bounded and read with the caller's schema. `AwsError` carries the service's code, the status, the request id and whether a repeat may succeed, never a message, the input or a credential. |

## Invariants

- **No AWS SDK** ([ADR-0081](../../docs/decisions/0081-the-aws-provider-calls-aws-without-the-sdk.md)). The clients are
  this package's own: a SigV4 signer pinned with known-answer tests, small JSON clients, `Bun.S3Client` for S3, a strict
  minimal XML reader for CloudFormation and RDS. Never add an `@aws-sdk/*` dependency.
- **The signer is security-critical.** `__tests__/sigv4.test.ts` pins it to AWS's published test vectors; a change
  that moves a known answer is wrong, not the vector. No error it raises quotes a header value, a body or a credential.
- **Every codec is strict and bounded.** A payload with a field this release does not know is refused, not dropped; a
  refusal names fields, never a value; every identifier has a bounded form, so no state nears Control's 16 KiB
  (`MAX_PROVIDER_STATE_BYTES`). Persisted state holds coordinates only, never a credential.
- **Unverified facts stay marked `UNVERIFIED:`.** The identifier forms follow AWS's published references; none was
  checked against an account. Promote one only after a live check.
- **No real account, resource or spend in tests**: fakes at the HTTP level, and local emulators where one exists.
