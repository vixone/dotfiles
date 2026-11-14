# Architecture examples

## Layered payment flow

Presentation handles user input and API validation. A payment service owns business rules. A repository owns persistence. The payment adapter owns the external provider contract. Keep the provider outside domain logic and document failure boundaries.

A directory map might name `src/payments/controller.ts`, `service.ts`, `repository.ts`, and `adapter.ts`; generated project briefs must give full actual paths and tests rather than copy this illustrative map.

## Interface contract

POST `/payments` accepts amount, currency, and an idempotency key. Document allowed currencies, amount limits, authorization, success structure, validation errors, business rejection, provider failures, and duplicate requests. Public behavior is visible to coders. Evaluator-only case inputs remain in holdouts.

## Runtime and UI

The user submits; validation rejects invalid data; the service handles a provider result; persistence records a successful transaction; the UI confirms. Specify error and retry paths as well as the happy path.

A payment form design defines empty, valid, loading, failed, and successful states. Record accessible labels, keyboard behavior, live announcements, responsive layout, and recovery without trapping users unnecessarily.

## Decisions and quality

Propose PostgreSQL versus other storage with consistency needs, existing expertise, migration cost, and alternatives. Record the approved choice in a closed mission decision child and reference it in the design.

A p95 latency target is meaningful only with a defined request population and measurement method. Test acceptance through the supported public interface, not implementation-specific class names.
