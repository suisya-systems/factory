# Request: a task board page with filters and undo

A task board for one person, used locally only. It has an HTTP API (every request and response body is JSON) and a page at `/` that works only through that API. Dates are `YYYY-MM-DD` strings; a date that is not a real calendar date is 400. Data is kept in memory; it does not have to survive a restart.

## API

- A task is `{"id", "title", "status", "due"}`: `status` is `"todo"`, `"doing"` or `"done"`, `due` a date or null. Ids are `"1"`, `"2"`, ... in creation order and never reused.
- `POST /tasks` with `{"title", "due"?}` adds a task with status `todo`: `title` is trimmed and must then be 1 to 60 characters; `due` defaults to null. 201 with the task.
- `PATCH /tasks/{id}` with any of `{"title", "status", "due"}` (same rules; `due` may be null) changes those fields; an empty body is 400. 200 with the task. `DELETE /tasks/{id}` deletes it; 204.
- `GET /tasks` returns 200 with the tasks in **board order**: tasks with a due date first, earliest date first; then tasks without one; within the same date (or no date), by id. `?status=` keeps one status (another value is 400). `?q=` keeps tasks whose title contains the text, ignoring case (an empty `q` keeps all). Both together keep tasks matching both.
- `GET /counts` returns 200 with `{"todo", "doing", "done", "all"}` over every task, whatever the filters.
- **Undo.** Every successful add, change and delete is recorded. `POST /undo` reverts the most recent one not yet undone and answers 200 with `{"undone": "add" | "change" | "delete", "task"}`, the task as it was before the undone action (for an add, as it was added). Undoing an add deletes the task; undoing a change puts back every field it changed; undoing a delete brings the task back with its id and fields. Calling it again reverts the one before, and so on; with nothing left it is 409. An undo is never itself recorded, so it cannot be undone, and actions made after an undo are recorded as usual.
- Errors: invalid JSON, a missing or wrong-typed field, or a value outside the rules above is 400; an unknown task is 404. A refused request changes nothing and is not recorded. Every error body is `{"error": string}`.

## The page `/`

Names in `code` below are test ids. Buttons are never disabled or hidden. The page has no timers: it changes only when the user clicks or the page is loaded.

- **Adding.** `titleInput`, `dueInput` (empty for no date) and `addButton`. A title empty after trimming shows `formError` `Enter a title`; one longer than 60 characters `Title is too long (60 at most)`; a due date that is not a real `YYYY-MM-DD` date `Enter the due date as YYYY-MM-DD`. With both title and date wrong both show, title first, one `formError` each. On a problem nothing is added and both inputs keep their text; on success both are emptied and `notice` shows `Added "{title}"`, or `Added "{title}" (hidden by the filters)` when the new task does not match the current filters.
- **Filters.** `filterAll`, `filterTodo`, `filterDoing` and `filterDone` choose the status filter (all at first). `searchInput` with `searchButton` sets the text filter to the trimmed input (empty clears it); typing alone does not filter. `filterLabel` shows the filters in effect: `All`, `To do`, `Doing` or `Done`, followed by ` matching "{text}"` while a text filter is set (`Doing matching "report"`). The list shows the tasks `GET /tasks` gives with both filters.
- **The list**, in board order, five tasks a page. Each task has `taskTitle`, `taskDue` (`due 2026-11-03`, or `no due date`), `taskStatus` (`To do`, `Doing` or `Done`), `advanceButton` and `deleteButton`. `advanceButton` moves `todo` to `doing`, `doing` to `done`, and `done` back to `todo`. With nothing to show, `emptyList` shows `No tasks match`.
- **Pages.** `pageInfo` shows `Page {n} of {m}` (`Page 1 of 1` when the list is empty); `prevPage` and `nextPage` move one page and do nothing on the first or last page. Changing either filter goes to page 1. After any other change the page stays where it was, or goes to the last page if it no longer exists. A task that leaves the filters after an advance disappears from the list at once.
- **Counts.** `countTodo`, `countDoing` and `countDone` show `To do: {n}`, `Doing: {n}` and `Done: {n}` from `GET /counts`, whatever the filters.
- **Undo.** `undoButton` calls `POST /undo`. `notice` then shows `Undid adding "{title}"`, `Undid a change to "{title}"` or `Undid deleting "{title}"` with the title from the answer, or `Nothing to undo` on 409. The list, page and counts show the board after the undo, with the filters kept.
- `notice` shows only the message of the last click; a click that sets none clears it. An advance or delete shows no notice. In every notice `{title}` is the saved (trimmed) title. After every click the list and counts show what the API gives. Reloading the page shows the saved tasks with no filters, page 1 and no notice.
