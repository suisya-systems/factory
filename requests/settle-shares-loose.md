# Request: settling up shared expenses, with shares and members who leave

An HTTP API for a group whose members pay for things on each other's behalf.

- Record the expenses that members of the group paid on behalf of others.
- An expense is split equally among the people it was for, or by shares (for example 2 : 1 : 1).
- A recorded expense can be corrected or deleted.
- A member can leave the group.
- Show each member's balance, and who should pay whom how much for everyone to be settled up.
- Amounts are in yen. Handle remainders (fractions of a yen) so that they are not skewed toward particular people.
