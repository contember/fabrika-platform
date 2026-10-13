---
id: 139
title: An application cannot author the HTML of IAM's e-mails
blocked-by: []
---

# 139 — An application cannot author the HTML of IAM's e-mails

**Summary.** WU4 shipped an MVP: an application words IAM's e-mails in plain text and IAM builds the HTML part. An
application that needs its own layout has no way to give one. Effort: M; it needs a decision on links first.

## Problem

`mail` in the vocabulary takes a `subject` and a `text` per kind and locale (`packages/auth-core/src/mail.ts`); the HTML
part is IAM's escaped text plus its button (`packages/iam/src/messages.ts`).

## Approach / acceptance

An `html` body beside `text`, parsed by a small tokenizer: no script, form, frame, event handler, `javascript:` or
`data:` URL, or remote resource; a link only to `{{actionUrl}}`, `mailto:` or the application's own origin. Return
origins are registered after the schema PUT, so a reconcile-time check against them would fail a first deploy: decide
between an `{{appUrl}}` placeholder IAM builds from the registered origin and a check at send time. Witness: the
refusals at the checker and at IAM's reconcile, and an application's HTML invitation rendered with escaped values.

<!-- Origin: the external-people sprint, WU4 (cut to an MVP by the owner). -->
