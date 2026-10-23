---
id: 218
title: The skill names no working one-click unsubscribe target
blocked-by: []
---

# 218: The skill names no working one-click unsubscribe target

**Summary.** Every unsubscribe the framework writes advertises RFC 8058 one-click, but the target the skill suggests
refuses the request a mailbox sends. Medium: a recipient's one-click unsubscribe fails silently.

## Problem

`ctx.mail.send({ unsubscribe: { url } })` writes `List-Unsubscribe: <url>` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click`. A mailbox then POSTs `List-Unsubscribe=One-Click` to that URL as
`application/x-www-form-urlencoded`.

`packages/app/skill/references/jobs.md` suggests a public procedure with the token in the query
(`ctx.url('api.mail.unsubscribe', { query: { t } })`) and says nothing about its method or body. A public procedure is
POST with a JSON body unless it declares otherwise (`rowWire` in `packages/app/src/contract/build.ts`), so its row
admits only `application/json`, and the proxy answers the mailbox's POST 400 `content_type` (`admitBody`,
`packages/proxy-core/src/authorize.ts`).

The build accepts the shape that should work, `http: { method: 'POST', body: 'urlencoded', query: z.strictObject({ t:
signedToken('unsubscribe') }) }` with a flat input. Whether an input field named `List-Unsubscribe` passes the build and
the urlencoded decoder is unchecked, no test drives a mailbox's POST through the proxy into such a procedure, and the
skill does not show it. A mailbox without one-click support opens
the same URL with a GET, which a POST-only procedure does not answer.

## Approach / acceptance

- Prove the one-click shape: a test sends RFC 8058's request (POST, urlencoded `List-Unsubscribe=One-Click`, no
  `Origin`, the token in the query) through the proxy's decision into a public procedure and reaches its handler.
- Decide the GET case: one URL that answers both (a GET page that confirms and a POST that unsubscribes), or the skill
  states that the one-click URL is POST-only and the body link is a separate GET procedure.
- Show the working declaration in `jobs.md` (and `endpoint.md`), and consider a checker hint when a job's `unsubscribe`
  URL names a procedure whose row does not admit `application/x-www-form-urlencoded`.

## Touch points

`packages/app/skill/references/jobs.md`, `packages/app/skill/references/endpoint.md`, `packages/app/src/contract/build.ts`,
`packages/proxy-core/src/authorize.ts`, the generated tests or the kit for the witness.

<!-- Origin: the Schrack CRM's move to Postmark on v0.8.2 (session crm-8e, 2026-10-23). -->
