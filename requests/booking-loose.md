# Request: booking meeting rooms

An HTTP API for booking a company's meeting rooms. It runs locally only (never exposed publicly).

- Rooms can be registered, each with a name and how many people fit in it.
- A room can be booked for a time range by a person, for a number of people.
- Two bookings of the same room must not overlap.
- A booking can be moved to another time or cancelled.
- For a given day, show the free times of a room, and find rooms that are free for a given time range and fit a given number of people.
- The office is in Tokyo.
