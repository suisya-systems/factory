# Request: memo API with tags, search, paging and safe concurrent updates

A small memo HTTP API that runs locally only (never exposed publicly). Every request and response body is JSON. Ids are strings the server assigns.

- A memo is `{"id", "title", "body", "tags", "version", "createdAt", "updatedAt"}`. `title` is 1 to 100 characters, `body` is 0 to 10,000 characters, `tags` is a list of 0 to 10 tags. A tag is 1 to 30 characters of lower-case letters a-z, digits and `-`; tags given in upper case are lower-cased, duplicates are removed, and the stored list is sorted. `version` starts at 1 and goes up by 1 on every update. Times are ISO 8601 in UTC with milliseconds (`2026-11-02T00:00:00.000Z`).
- `POST /memos` with `{"title", "body"?, "tags"?}` creates a memo (`body` defaults to "", `tags` to []): 201 with the memo and a `Location: /memos/{id}` header. `GET /memos/{id}`: 200 with the memo and an `ETag` header `"<version>"` (the version in double quotes).
- `PATCH /memos/{id}` with any of `title`, `body`, `tags` updates those fields only. The request must carry `If-Match: "<version>"`: without it, 428; if it is not the current version, 412 with the current memo as the body; otherwise 200 with the updated memo and its new `ETag`. `DELETE /memos/{id}` also requires `If-Match` the same way and returns 204.
- `GET /memos` lists memos, newest `createdAt` first; memos with the same `createdAt` are ordered by id, ascending as strings. Query parameters, all optional and combinable (all given conditions must hold):
  - `tag`: may be repeated; a memo matches when it has every given tag (compared after lower-casing).
  - `q`: words separated by spaces; a memo matches when its title or body contains every word, case-insensitively, as a substring.
  - `limit`: 1 to 100, default 20. `cursor`: a value returned as `nextCursor` by a previous call with the same `tag` and `q`.
  - The response is 200 with `{"items": [memo, ...], "nextCursor": string | null}`; `nextCursor` is null on the last page. Memos created or deleted between page requests must not make a later page repeat or skip a memo that existed throughout.
- Errors: invalid JSON, a missing or wrong-typed field, an unknown field, or a value outside the rules above (including a bad `limit` or an unknown `cursor`) is 400; an unknown memo id is 404. Every error body is `{"error": string}`.
- Data is kept in memory; it does not have to survive a restart.
