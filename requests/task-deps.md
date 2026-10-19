# Request: project tasks with dependencies and a schedule

An HTTP API for planning the tasks of small projects. Every request and response body is JSON. Ids are strings the server assigns. Dates are `YYYY-MM-DD` strings; a date that is not a real calendar date is 400. Durations are whole calendar days.

- `POST /projects` with `{"name": string, "startDate": date}` creates a project (name 1 to 100 characters). 201 with `{"id", "name", "startDate"}`.
- `POST /projects/{id}/tasks` with `{"title": string, "duration": integer, "dependsOn"?: [taskId, ...]}` adds a task (title 1 to 100 characters, `duration` 1 to 365, `dependsOn` defaults to `[]`, each id a task of the same project, listed at most once; 404 for an unknown id). At most 100 tasks per project. 201 with the task. A task is `{"id", "title", "duration", "dependsOn", "status", "startedOn", "finishedOn"}`; `dependsOn` is kept in the order given, then the order added. A task's **dependents** are the tasks whose `dependsOn` contains it.
- `POST /tasks/{id}/dependencies` with `{"on": taskId}` makes the task depend on another task of the same project. 409 if it already does, if `on` is the task itself, or if the new dependency would make a cycle (the task would come to depend on itself through other tasks). Adding a dependency on a task that is not `done` to a task that is `doing` is also 409. 200 with the task. `DELETE /tasks/{id}/dependencies/{onId}` removes one (404 if the task has no such dependency); 200 with the task.
- **Status.** A task's stored state is `todo`, `doing` or `done`. The `status` it reports is `blocked` when its state is `todo` and at least one of its dependencies is not `done`; otherwise its state.
  - `POST /tasks/{id}/start` with `{"on": date}`: only from `todo` with every dependency `done` (409 otherwise); `on` is not before the project's `startDate` nor before any dependency's `finishedOn` + 1 day (400 otherwise). The task becomes `doing` with `startedOn` = `on`.
  - `POST /tasks/{id}/finish` with `{"on": date}`: only from `doing` (409 otherwise); `on` is not before `startedOn` (400 otherwise). The task becomes `done` with `finishedOn` = `on`.
  - `POST /tasks/{id}/reopen`: only from `done` (409 otherwise). The task becomes `todo` and loses `startedOn` and `finishedOn` (both null). Every task that depends on it directly or through other tasks and is `doing` also becomes `todo` and loses `startedOn`; tasks that are `done` stay `done`.
  - All return 200 with the task.
- `DELETE /tasks/{id}` removes a task: 409 if it has dependents, unless `?cascade=true` is given, in which case its dependents are removed too, and theirs, and so on. 204.
- `GET /projects/{id}/schedule` returns 200 with `{"tasks": [{"id", "start", "finish", "slack", "critical"}, ...], "end"}`, computed this way:
  - A `done` task has `start` = `startedOn` and `finish` = `finishedOn`. A `doing` task has `start` = `startedOn` and `finish` = `startedOn` + `duration` - 1 day. A `todo` task (blocked or not) has `start` = the latest of the project's `startDate` and each dependency's `finish` + 1 day, and `finish` = `start` + `duration` - 1 day.
  - `end` is the latest `finish` of all tasks (`null` for a project without tasks).
  - Latest dates: a task without dependents has `latestFinish` = `end`; otherwise `latestFinish` = the earliest of each dependent's `latestStart` - 1 day; `latestStart` = `latestFinish` - `duration` + 1 day. For a `done` or `doing` task, `slack` is 0; for a `todo` task, `slack` = the number of days from `start` to `latestStart` (never negative; 0 when `latestStart` is not after `start`).
  - `critical` is true when `slack` is 0 and the task is not `done`.
  - Tasks are listed by `start`, then by the order they were added.
- `GET /tasks/{id}` returns 200 with the task. `GET /projects/{id}/tasks?status=s` lists the project's tasks in the order added, optionally only those whose reported `status` is `s` (`todo`, `blocked`, `doing` or `done`; anything else is 400).
- Errors: invalid JSON, a missing or wrong-typed field, or a value outside the rules above is 400; an unknown project or task is 404; the refusals named above are 409. Every error body is `{"error": string}`.
- Data is kept in memory; it does not have to survive a restart.
