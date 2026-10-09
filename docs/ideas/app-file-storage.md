# Application file storage

A proposal for how Fabrika applications store and serve files ("attach a file to a note"). It is part of the
[opinionated application framework](opinionated-app-framework.md): an agent steered by an inexperienced person must
not be able to expose a file to someone who may not see its parent object.

v1 is Zerops-only, because it depends on the Postgres [data layer](scoped-database-access.md).

## Threats specific to files

1. **A public bucket.** "Images do not load" is fixed by setting the bucket to `public-read`, which on Zerops
   means anonymous `ListBucket` plus `GetObject` — every file of every user.
2. **Long-lived or unbound presigned URLs** that keep working after access is revoked, leak through logs and
   referrers, or point at a key the client chose.
3. **Downloads without a check of the parent object** — `GET /files/:key` that serves any key.
4. **Client-chosen object keys** — path traversal, overwriting another user's file.
5. **Stored XSS** — an uploaded HTML or SVG file served inline from the application's origin runs as the
   signed-in user.
6. **Unbounded uploads** — size, type and count.
7. **A new collection silently reachable through existing share links.**

## A file belongs to an object

Files are declared in the contract as a collection attached to a table with a scope (its **owner**). A file
inherits the owner's access; it has no access rules of its own.

```ts
files: {
	attachments: c.files({
		owner: 'notes', // a table with a policy; files inherit note → workspace
		read: 'notes.read',
		write: 'notes.write',
		delete: 'notes.write',
		maxBytes: 25 * 1024 * 1024,
		types: ['image/png', 'image/jpeg', 'application/pdf'],
		maxPerOwner: 50,
		link: false, // true: holders of a share link to the owner can download
	}),
},
```

A collection declares the dimension `file:attachments`, contained in the owner's dimension. The contract compiler
generates three endpoints, with the core's access forms and their own kinds:

| Endpoint                                       | Kind       | Access                                                   | Behaviour                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ---------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/files.attachments.upload/<ownerId>` | `upload`   | `{ action: write, on: 'note', from: 'owner' }`           | the body is the file bytes; the declared types are admitted instead of JSON, with the same same-origin check; the framework streams to storage, enforces `maxBytes` while streaming, sniffs the type from the first bytes and refuses a mismatch, records the row, and answers the file's id |
| `GET /api/files.attachments/<fileId>`          | `download` | `{ action: read, on: 'file:attachments' }`               | the generated locator is `file → note → workspace`; the owner row must still exist and the file must not be deleted; streams from storage                                                                                                                                                    |
| `POST /api/files.attachments.remove`           | `rpc`      | `{ action: delete, on: 'file:attachments', from: 'id' }` | marks the row deleted; a framework job removes the object later                                                                                                                                                                                                                              |

The download endpoint is a `GET` with a parameter so that a file works as a link and as `<img src>` for a
signed-in user (the session cookie travels with it).

Handlers that need files outside the generated endpoints get the same API, bound to an action-carrying `Ref`:
`ctx.deps.files.attachments.list(ctx.target)`. There is no API that takes a key or a bare id.

## Storage

- **The bucket is always private.** The Zerops provider refuses every storage policy that is not private on
  application services, including `custom` with a raw policy. This refusal ships now, independent of the rest.
  Zerops has no known API to read a bucket policy back, and a re-applied import ignores changed fields on existing
  services, so a policy changed outside Fabrika is not detected. With platform enforcement, an application may use
  only buckets the platform created as private and recorded as such; an unknown existing bucket is refused.
- **Credential custody.** The framework reads the storage credential from a framework-only variable while building
  `deps` and removes it from `process.env`; the checker refuses S3 and R2 clients in application code.
- **Object keys are generated:** `<collection>/<uuidv7>`. The client's file name is metadata only.
- **One table per collection** in the application's schema, created by an application migration from
  `fileTableSql` of `@fabrika/db`: `fabrika_files_attachments (id, owner_id, <owner chain columns>, status,
  object_key, size, content_type, sha256, original_name, created_by, created_at, deleted_at)`, with a composite
  foreign key to the owner over its key and chain columns, `ON UPDATE CASCADE`, so a move of the owner moves its
  files and ownership cannot go stale. A polymorphic table for every collection cannot carry such a foreign key.
  (Built in part A: [application runtime](../reference/application-runtime.md#file-collections).)

## Serving

Every download carries the **file treatment**, a header policy of its own:

- `Content-Disposition: attachment` for every type except inert images (`image/png`, `image/jpeg`, `image/gif`,
  `image/webp`), which are served `inline`. SVG and HTML are always attachments.
- `Content-Type` from the recorded, sniffed type — never from the upload request.
- `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`.
- `Cache-Control: private, no-store`, so a revoked user cannot read a cached copy.

The framework sets these headers on the generated download endpoint; handler code cannot change them. With
platform enforcement the proxy sets them too, so they hold even if the application code is changed.

Every byte passes through the proxy. The documented request ceilings (Cloudflare 100 MB on Free and Pro; the Zerops
balancer's configurable default) are above the v1 cap of 25 MiB; the application runtime's memory and timeouts
must still be checked for streaming.

## Share links

A collection with `link: true` is reachable by holders of a share link to its owner, through the link mount: the
share SPA fetches `GET /s/files.attachments/<fileId>` with the link key as a bearer and shows the file through a
`blob:` URL. A link can never reach a file of another owner, and a collection without `link: true` is never
reachable by a link.

## Presigned URLs: not in v1

If large files need direct-to-storage transfer later:

- upload: a presigned `PUT` minted after the access check, for a generated key, bound to the exact length and
  type, valid for at most five minutes, followed by a `finalize` endpoint that verifies the object and records the
  row;
- download: a presigned `GET` valid for at most one minute, minted per request after the access check, never
  embedded in a page or stored.

Both would be declared (`direct: true`), because a URL escapes the proxy for its lifetime.

## Changes that wait for approval

With platform enforcement, Control compares the contract with the environment's active one. These file changes
wait for a human on a protected environment:

| Change                                            | Waits on a protected environment |
| ------------------------------------------------- | -------------------------------- |
| A new file collection                             | yes                              |
| A collection's `read`, `write` or `delete` action | yes                              |
| `link: true`                                      | yes                              |
| `direct: true` (presigned URLs)                   | yes                              |
| `maxBytes`, `types` or `maxPerOwner` changed      | no (not access data)             |
| A collection removed, or a limit lowered          | no                               |
| A storage policy that is not private              | refused, no approval path        |

## Framework (part A)

What the framework gives on today's platform:

- collections bound to an owner table; generated endpoints and locators; generated keys; sniffed types;
  per-collection tables with composite foreign keys; the file treatment on downloads;
- the Zerops refusal of non-private bucket policies (shipped now);
- the checker: no storage client in application code; no building of download URLs by hand;
- the agent skill: "to attach files, declare a collection on the owner table"; never change a bucket policy; never
  return a storage URL to the browser.

## Platform enforcement (part B)

What [platform enforcement](platform-enforcement.md) adds:

- the proxy sets the file treatment on download endpoints and admits uploads by their declared types;
- buckets only when created by the platform as private, with recorded provenance;
- collection changes wait for approval on protected environments.

## Open questions

- Virus scanning: a cron hook over new files, or out of scope?
- Image thumbnails: a derived file in the same collection, generated by a cron job.
- Quotas per scope (total bytes per workspace).
