# Request: user notifications through a messaging service, with digests and rate limits

An HTTP API that turns events into e-mail notifications and sends them through an outside messaging service. Every request and response body is JSON. Ids are strings the server assigns.

- **The external service.** The messaging service is at the base URL in `process.env.SERVICE_URL`. Its only endpoint is `POST /messages` with the JSON body `{"to": email, "subject": string, "text": string}` and an `Idempotency-Key` header. It answers 202 with `{"id": string}` when it accepts the message, 429 with a `Retry-After` header (a whole number of seconds) when the sender is sending too fast, 400 to 499 other than 429 when it rejects the message, and 500 to 599 when it fails. Any answer not listed above (for example a 200, or a 202 without `id`), or no answer, is handled like a 5xx.
- **The app's clock.** The server keeps the time `now`, a whole number of minutes starting at 0. `GET /clock` returns 200 with `{"now"}`. `POST /clock` with `{"advance": integer}` (1 to 1440) adds to `now` and then makes a delivery round (below); 200 with `{"now", "sent": [messageId, ...]}`, the messages the service accepted during the round, in the order sent.
- `POST /users` with `{"email": string, "mode": "instant" | "digest", "muted"?: [topic, ...]}` adds a user: `email` 3 to 200 characters with exactly one `@`, `muted` a list of distinct topics (default empty). 201 with the user `{"id", "email", "mode", "muted", "pending": 0, "pausedUntil": null, "left": false}`. `pending` counts the user's events waiting for a digest.
- `PUT /users/{id}` with `{"mode", "muted"}` changes a user's settings (200 with the user). When a `digest` user becomes `instant`, their pending events are made into a digest message at once (below), and the user's queue is sent.
- `DELETE /users/{id}` makes the user leave: `left` becomes true, their pending events are dropped and every `queued` message of theirs becomes `discarded`. Nothing more is ever sent to them. 204. Events, settings changes and a second leave for a user who left are 409.
- **Events.** `POST /events` with `{"userId", "topic": string, "text": string}` (topic 1 to 40 characters, text 1 to 500) records an event for a user. 201 with `{"id", "outcome", "messageId"}`:
  - if the topic is in the user's `muted`, `outcome` is `"muted"` and nothing else happens;
  - for a `digest` user the event waits for the next digest: `outcome` `"pending"`, and `pending` grows by 1;
  - for an `instant` user a message with `subject` the topic and `text` the event's text is added at the end of the user's queue (`outcome` `"message"`), and the user's queue is sent.
  `messageId` is the id of the message the event made, or null.
- **Messages.** A message is `{"id", "userId", "subject", "text", "status", "attempts", "serviceId"}`; `status` is `queued`, `sent`, `failed` or `discarded`, `attempts` counts the requests sent for it and `serviceId` is the service's `id` once accepted (null before). A user's queue is their `queued` messages in creation order.
- **Sending a user's queue.** Nothing is sent while the user is paused (`pausedUntil` is greater than `now`). Otherwise the app sends the queued messages one at a time, oldest first, each as `POST /messages` with the user's email, the message's subject and text, and the header `Idempotency-Key: {messageId}` (the same key every time the message is sent). For each answer:
  - 202: the message is `sent` and the next one is sent;
  - 429: the message stays queued, `pausedUntil` becomes `now` plus the `Retry-After` seconds rounded up to whole minutes (at least 1; a missing or non-integer `Retry-After` counts as 60 seconds), and sending stops for this user;
  - other 400 to 499: the message is `failed` and the next one is sent;
  - anything else: the message stays queued and sending stops for this user until something sends their queue again.
  Other users are not affected.
- **Digests.** A digest is one message made from all of a user's pending events, oldest first: `subject` `"Digest: {n} updates"` (`"Digest: 1 update"` for one event) and `text` the events' texts joined with a newline (`"\n"`). It joins the end of the user's queue and `pending` returns to 0. With no pending events no digest is made.
- **The delivery round.** For each user who has not left, in the order the users were added: if `pausedUntil` is not greater than `now`, it becomes null; if the user is in `digest` mode and the clock move reached or passed a multiple of 60 minutes (60, 120, ...), a digest is made (one per round, however many multiples were passed); then the user's queue is sent.
- `GET /users/{id}` returns 200 with the user. `GET /users/{id}/messages` returns 200 with all of the user's messages in creation order. `GET /messages/{id}` returns 200 with a message.
- Errors: a body that is not valid JSON, a missing or wrong-typed field, or a value outside the rules above is 400; an unknown user or message is 404; the conflicts named above are 409. A refused request changes nothing and sends nothing. Every error body is `{"error": string}`.
- Data is kept in memory; it does not have to survive a restart.
