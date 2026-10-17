# Request: change history and revert for the memo API

This extends the existing memo API.

- Every change to a memo is kept in its history.
- A memo can be reverted to any earlier version in its history.
- A revert is itself recorded in the history.
- Reverting must not contradict how conflicting concurrent updates are handled.
- The history list is split into pages.
