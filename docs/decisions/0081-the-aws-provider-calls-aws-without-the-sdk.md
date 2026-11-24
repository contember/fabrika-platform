---
id: 0081
title: The AWS provider calls AWS without the SDK
status: accepted
date: 2026-11-24
---

# 0081: The AWS provider calls AWS without the SDK

## Context

`@fabrika/provider-aws` ([the AWS idea](../ideas/aws-provider.md)) calls ECS, CodeBuild, ECR, SSM Parameter Store,
CloudWatch Logs, CloudFormation, RDS and S3. ECS, CodeBuild, ECR, SSM and Logs speak AWS's JSON protocol; CloudFormation
and RDS speak the older query protocol, whose answers are XML. Every request is signed with Signature Version 4.

A provider package is installed by every application on its cloud, because it carries `defineApp`, and by Control's
composition. What it depends on is what every such install pulls. The other providers call their clouds over plain
HTTP: Zerops through its own REST client (ADR-0003), and S3 everywhere through Bun's built-in `Bun.S3Client`
(`@fabrika/platform-node`'s `S3BlobStore`), with no SDK.

## Decision

We will call AWS with code of our own, inside `@fabrika/provider-aws`:

1. **A SigV4 signer of our own**, pinned with known-answer tests, AWS's published Signature Version 4 test vectors
   where they apply.
2. **Small JSON clients** for the calls the provider makes to ECS, CodeBuild, ECR, SSM and CloudWatch Logs, each
   answer read with a strict schema.
3. **S3 through `Bun.S3Client`**, as today: the source upload's multipart writer and the presigned read the build
   fetches, with the container credentials `@fabrika/platform-node` already refreshes.
4. **A strict, minimal XML reader** for the few CloudFormation and RDS answers the provider reads: elements and text
   only, no DTD, no entities beyond the five XML predefines, bounded in size and depth, each answer read against the
   fields it expects.

Every client follows the repository's rules for a credentialed request: `redirect: 'manual'`, a 3xx is not ok, and no
error carries a request, a signature or a body. The fakes the tests run against sit at the HTTP level.

## Consequences

- The package adds no dependency beyond the workspace and `zod`; an application on AWS installs no SDK.
- The signer is security-critical code we own. It needs the known-answer tests before any client uses it, and a change
  to it is reviewed as one.
- Each AWS call the provider needs is written and tested by hand, a few days more than with the SDK in total, and a call
  the SDK would give for free (pagination, waiters, retries with backoff) is ours to write where it is needed.
- A service that moves to another protocol (AWS has been moving services to newer wire protocols) changes that client
  only; the signer stays.
- No installation changes: the package is private and builds nothing an existing installation runs.

## Alternatives considered

- **The modular AWS SDK v3 clients**, one package per service. They handle every protocol, the XML query APIs
  included, with retries and credential providers built in, and would save about two to three days. They bring roughly
  a hundred transitive packages into a package every AWS application installs, a supply-chain surface the repository
  has avoided so far, and they would be the one SDK among providers that call their clouds over plain HTTP.
- **The SDK for CloudFormation and RDS only**, our own clients for the JSON services. It keeps the same dependency tree
  in the same package for the few calls that need XML, so it buys little over the reader.
