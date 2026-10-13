---
id: 0043
title: Validate and render one Zerops descriptor meaning
status: accepted
date: 2026-09-28
---

# 0043 — Validate and render one Zerops descriptor meaning

## Context

Fabrika checked source descriptors with Bun's YAML parser and sent their original text to Zerops.
Local witnesses reproduced an ownership-check bypass: Bun retained a `!!binary` value as base64
text while both pinned Go YAML readers decoded it into a foreign-service reference. Reader differences
also affect duplicate keys, scalar types and Unicode separators. Checking one interpretation and
executing another cannot enforce the provider's service-reference boundary.

## Decision

Use the maintained `yaml` v2 parser to validate an explicit descriptor subset at the manifest boundary.
Reject explicit tags, anchors, aliases, merge keys, duplicate or non-string keys, multiple documents,
parser warnings, ambiguous plain scalars, inexact numbers and unsupported raw Unicode characters.
Ordinary mappings, sequences, comments, block/flow syntax and quoted strings remain supported.

Select a single setup deterministically: the sole setup may be implicit; multiple setups require an
explicit selector. The executed setups are the selected one and, transitively, every setup it
`extends`; an unknown parent is refused. Check decoded keys and string values in the executed setups
for foreign-service references, and send Zerops a document holding only those setups, through the
shared YAML emitter, with the selected setup passed explicitly on both initial builds and recovered
builds. A sibling setup for another placement or another app in the same file may therefore name
services this app does not own: it is never checked against this app and never reaches Zerops for it.
A selected setup that extends another must declare its own `run`, because Zerops merges `extends` per
whole section and the deploy writes `FABRIKA_RELEASE` into `run`; registration refuses it.

One path still builds a setup this check never read: an app's import service that carries
`buildFromGit` with `zeropsSetup` makes Zerops build that repository's own `zerops.yaml` at import.
It predates this rule and bypasses the registered descriptor entirely.

**Invariant:** the persisted source descriptor and its SHA-256 remain the exact original source bytes.
Source resolution and archive verification use that identity, never the canonical execution document.

The compatibility comparison with YAML 1.1 is a conservative rejection rule, not an emulation of
Zerops. Independent Go-reader witnesses verify emitted values in addition to TypeScript tests.

## Consequences

The execution document has the same decoded meaning that passed ownership checks, and holds nothing else.
One `zerops.yaml` can carry a setup per placement (an app's cheap and dedicated tiers) or per app in a
monorepo. A descriptor using
unsupported syntax must be rewritten into the accepted subset, usually by quoting ambiguous values
or expanding aliases. This is an intentional input-contract restriction, approved before implementation.

Original source identity and execution serialization are separate. A future platform-owned overlay
must preserve that distinction and undergo its own contract review; this decision approves no secret
overlay or activation protocol.

## Alternatives considered

- Keeping the original YAML with a different parser still leaves downstream interpretation differences.
- JSON-only authoring would unnecessarily reject normal committed YAML descriptors.
- Supporting every YAML feature would require additional rules for tags, aliases, merge semantics and
  reader-specific coercion. The strict subset meets the current application requirements.
