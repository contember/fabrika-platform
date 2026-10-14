---
id: 145
title: A link collection serves every link mount of its dimension
blocked-by: []
---

# 145 — A link collection serves every link mount of its dimension

**Summary.** `link: true` on a file collection serves upload, list and download under every link mount bound to the
owner's dimension, and each such mount must grant the collection's actions. A link meant for one button cannot be kept
away from the record's documents. Effort: S.

## Problem

- `#linkFiles` (`packages/app/src/contract/build.ts:975`) takes every link mount whose `dimension` is the owner's and
  refuses one that does not grant the collection's `read` and `write`. `link` is a boolean
  (`packages/app/src/contract/define.ts:356`).
- An application built on the paved road e-mails a record a one-click "interested" link and, separately, a link to
  complete missing fields with a document. Both are link mounts bound to the same dimension, so the one-click link
  also lists and uploads the record's documents.
- Workaround: the one-click button carries no link at all. The job puts a random one-time token in the URL fragment,
  stores its SHA-256, and an anonymous form takes it. The link mount now serves only the completion.
- The skill does not say that a link holder's `ctx.principal.credentialId` is the id `ctx.links.issue` answered, which
  the application relied on to find the request a link was issued for.

## Approach / acceptance

- `link` names the mounts it serves (`link: ['completion']`); `true` stays "every mount of the dimension" or is
  removed. A mount not named need not grant the collection's actions, and serves no file row.
- `references/webhooks-links-connectors.md` states that `credentialId` is the issued link's id.
- Witness: a contract with two link mounts where one is named; the other's key gets 404 on the file rows.

## Touch points

`packages/app/src/contract/{build.ts,define.ts,declaration.ts}`,
`packages/app/skill/references/{files.md,webhooks-links-connectors.md}`.
