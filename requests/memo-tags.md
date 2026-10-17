# Request: tags, search, paging and safe concurrent updates for the memo API

This extends the existing memo API.

- Memos can have tags.
- Memos can be filtered by tag and by words in the memo body.
- The memo list is split into pages.
- When the same memo is updated by two requests at the same time, the later update must not silently erase the earlier one.
