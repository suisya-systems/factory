# Request: memo API with tags, search, paging and safe concurrent updates

A small memo HTTP API that runs locally only (never exposed publicly).

- It should be possible to create, list, get, update and delete memos.
- Memos can have tags.
- Memos can be filtered by tag and by words in the memo body.
- The memo list is split into pages.
- When the same memo is updated by two requests at the same time, the later update must not silently erase the earlier one.
