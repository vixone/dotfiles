# Example: payment request requirements

This is illustrative public behavior, not research evidence about a real business.

## Problem and user

A solo service merchant needs to request payment after completing a service. Confirm the cost of delayed payment with the user before setting business targets.

## Must-have behavior

R1: As a merchant, I want to send a payment request so that my customer can pay without separate manual instructions.

AC1: Given an authorized merchant and a valid amount, when the merchant submits a request, then the customer receives a payment link.

AC2: Given an invalid amount, when the merchant submits, then the request is rejected with correction guidance and no payment is created.

R2: Both parties receive confirmation when payment succeeds. Payment failures provide retry guidance without duplicate charges.

## Metrics

Measure request creation, successful payment, failure class, and elapsed time. Numeric targets require user confirmation. Do not silently copy example targets into a project.

## Review output

The report identifies reviewed sections and remaining questions. If notification channels are unspecified, ask the user rather than mark the requirements complete.
