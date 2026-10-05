# Static validation — retained boundaries

Parent: [static validation sprint](sprint-2026-10-05-static-validation.md).

Structural parsing moves to owner-local schemas. These checks remain deliberately
native because they enforce domain rules, preserve runtime identity, or own an
opaque payload rather than a fixed DTO.

| Unit      | Retained boundary                                                                               | Reason                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| WU01      | Embedded approval parser                                                                        | Serialized through `.toString()`; must remain self-contained.                                                |
| WU02      | Operations RPC diagnostic adapter                                                               | Explicitly approved to preserve exact errors and first-error precedence; structure is validated only by Zod. |
| WU02      | Opaque event/activity payloads, telemetry coercion and exception selection                      | Preserve extensions, original bytes and different ingest/detail projection policies.                         |
| WU02      | SQL numeric conversion, credential/revision/health/HTTP rules                                   | Domain or native scalar semantics.                                                                           |
| WU03      | Device and access claims                                                                        | Owned by dependency-free auth-core; not duplicated in IAM.                                                   |
| WU03      | Handoff consumption, scope/role/expiry/delegation checks, password hex/constant-time comparison | Security ordering and domain invariants remain with their owners.                                            |
| WU03      | Scalar environment values, pagination, audit JSON                                               | Native parsing/defaults and opaque payload contracts.                                                        |
| WU04      | Forwarded headers, URL-origin handling, cookies and exact `off`/`parseInt` configuration        | Scalar/security semantics; schemas would add indirection without simplifying structure.                      |
| WU04      | Signature verification, caches, denial mapping and gate evaluation                              | Identity-sensitive crypto and policy ownership.                                                              |
| WU07      | YAML AST/source checks, Unicode restrictions, dual-reader comparison                            | Need original source evidence, not a cloned object.                                                          |
| WU07      | Pipeline/permission array refinements                                                           | Preserve caller-observable object identity after structural validation.                                      |
| WU07      | Digests, canonical hashes, foreign references, CAS/provenance/admission                         | Persisted identity and domain invariants.                                                                    |
| WU07      | Executable authoring, CLI tokenization, URL policy and API pagination/status rules              | Runtime identity, lexical parsing and domain behavior.                                                       |
| WU08      | Flag tokenization/precedence and source/release/project selection                               | Command-specific scalar and domain rules.                                                                    |
| WU08/WU09 | Public provider generator and upstream documents                                                | Installation subset is not the full public authoring catalog; WU09 remains conditional.                      |
| WU13      | URL security, executable module extraction, custody/consent/state machine                       | Domain policy and runtime identity.                                                                          |
| WU13      | Opaque response storage and Builder-specific draft eligibility                                  | Host extensions survive; Builder admission intentionally differs from Canvas recovery.                       |
| WU14      | Compiler prop validation, diagnostics, React/DOM recognition                                    | Executable objects and branded/runtime identity must not be cloned.                                          |
| WU14      | Opaque host response storage and meaningful-content predicates                                  | Host owns payload shape; content checks operate after structural parsing.                                    |

WU11 source request and credential structures already delegate to WU06. Dynamic
slot discovery, URL/identity association, signing/PEM and archive topology/digest
admission remain domain/native checks. WU12 keeps installer auth/email pairing,
account paths, timeouts and CLI/env tokenization as small native scalar checks
with existing diagnostic order and defaults.

The dependency-free auth-core parsers, Standard Schema-neutral app runtime,
and dynamically imported installation module/function recognition retain their
existing architectural contracts. The shared approval parser stays embeddable.

All units retain native JSON/YAML syntax decoding. A native decoder is not a
duplicate structural validator. No gate evaluator moved, and `@fabrika/app`
remains Standard Schema-neutral.
