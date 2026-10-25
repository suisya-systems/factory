# Request: booking one-hour room slots, with a page per day

An app where people book one-hour slots in shared rooms, used locally only. It has an HTTP API (every request and response body is JSON) and a page at `/` that works only through that API. Ids are strings the server assigns. Dates are `YYYY-MM-DD`; one that is not a real calendar date is 400. Times are whole hours `HH:00`. Data is kept in memory; it does not have to survive a restart.

## API

- **The clock.** The server keeps the time `now` as `{"date", "time"}`, starting at `2026-11-02` `08:00`. `GET /clock` returns 200 with it. `POST /clock` with `{"date", "time"}` sets it; an earlier time than `now` is 409. A slot **has started** when its date and start are not later than `now`.
- `POST /slots` with `{"date", "start", "room", "capacity"}` adds a slot: `start` from `09:00` to `17:00`, `room` 1 to 20 characters, `capacity` 1 to 10. A second slot with the same date, start and room (ignoring case) is 409. 201 with `{"id", "date", "start", "room", "capacity", "booked": 0}`.
- `GET /slots?date=...` (required) returns 200 with that date's slots, by start, then by room name (ignoring case), each with `booked`, its number of bookings.
- `POST /bookings` with `{"slotId", "user"}` (`user` 1 to 30 characters after trimming, compared ignoring case) books one place. It is refused with 409 and `{"error", "reason"}`, checking in this order: `"started"` (the slot has started), `"full"` (`booked` equals `capacity`), `"overlap"` (the user already has a booking at the same date and start, in any room), `"limit"` (the user already has 3 bookings in slots that have not started). Otherwise 201 with `{"id", "slotId", "user"}`; the slot's `booked` grows by 1.
- `GET /bookings?user=...` returns 200 with the user's bookings in slots that have not started, by date and start, each `{"id", "slotId", "date", "start", "room"}`.
- `DELETE /bookings/{id}` cancels a booking and frees its place; 204. It is refused with 409 and `{"error", "reason": "late"}` when `now` is less than 2 hours before the slot's start, or later (for a `10:00` slot, cancelling at `08:00` is allowed and at `09:00` late).
- Errors: invalid JSON, a missing or wrong-typed field, or a value outside the rules above is 400; an unknown slot or booking is 404. A refused request changes nothing. Every error body has `"error": string`.

## The page `/`

Names in `code` below are test ids. Buttons are never disabled or hidden. The page has no timers: it reads the API when it loads and after every click.

- **Who and when.** `userInput` (the user's name), `dateInput` and `showButton`. `showButton` shows the slots of the date typed for the user typed. A name empty after trimming shows `message` `Enter your name`; a date that is not a real `YYYY-MM-DD` date `Enter the date as YYYY-MM-DD` (the name is checked first); with a problem the list shown before stays. `clockNow` shows `Now: {date} {time}` as read from `GET /clock`. `listDate` shows `Slots on {date}` for the date shown, and nothing before the first show.
- **Slots**, in the API's order. Each has `slotLabel` (`{start} {room}`), `slotState` and `bookButton`. `slotState` is, in this order: `Started` once the slot has started; `Booked by you` when the shown user has a booking in it; `Full` when it is full; else `{n} of {capacity} left`. A slot showing `Booked by you` also shows `cancelButton`. With no slots, `noSlots` shows `No slots on {date}`.
- **Booking.** `bookButton` books the slot for the shown user (the name given at the last show, not what is typed since). On success `message` shows `Booked {start} {room} on {date}`. A refusal shows, by its reason: `This slot has started`, `This slot is full`, `You already have a booking at {start}`, `You can have at most 3 upcoming bookings`. Clicking `bookButton` on a slot showing `Booked by you` sends the request like any other: the full message if it is full, else the overlap one.
- **Cancelling.** `cancelButton` cancels the shown user's booking in that slot. On success `message` shows `Cancelled {start} {room} on {date}`; a late refusal `Too late to cancel: cancel at least 2 hours before the start`.
- **My bookings.** `myBooking` lists the shown user's bookings from `GET /bookings`, one element each in its order, written `{date} {start} {room}`; with none, `noBookings` shows `No upcoming bookings`.
- After every click the page reads the clock, the slots and the bookings again, so a slot that filled or a clock that moved through the API since the last read shows at once, after a refusal too. `message` shows only the message of the last click; a click that sets none clears it. Reloading the page shows no list and no message, with the inputs empty.
