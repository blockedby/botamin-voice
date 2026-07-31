# Agent A4 — Booking domain, data and notifications

## Mission

Implement the transaction boundary that guarantees one durable booking before optional qualification.

## Read first

- booking requirements in `docs/01-product-requirements.md`
- lifecycle in `docs/04-conversation-design.md`
- full contracts in `docs/05-api-events-data.md`
- T14 in `tasks/tasks.yaml`

## Branch and ownership

Branch: `agent/booking-domain`.

Owned: domain, DB, migrations, notifiers and outbox. Do not change prompts or provider adapters.

## Deliverables

- Drizzle SQLite schema and migrations;
- `createBooking` transaction and idempotency table;
- `appendQualification` patch merge;
- append-only domain events;
- console notifier and webhook interface/outbox;
- deletion and redaction helpers;
- restart and concurrent retry tests.

## Invariants

- unique booking per conversation;
- successful commit precedes notification and assistant confirmation;
- notifier failure never rolls back booking;
- qualification cannot create a booking or change status away from booked;
- same key with different payload is a conflict;
- generic logs do not contain raw contact values.

## Completion report

Commit SHA, migration list, transaction design, concurrency test output, sample redacted events, and any schema decision that differs from spec.
