---
date: 2026-09-15
attendees: [Priya, Tom, Sam, me]
project: "[[Onboarding redesign]]"
---
# Design review: onboarding checklist

## Context
Priya showed the second version of the first-run checklist. The first version had seven steps and tested poorly: people closed it on the first screen.

## Decisions
- The checklist goes from seven steps to four: create a client, draft an invoice, connect a bank account, send the invoice.
- People can dismiss it and bring it back from the help menu.
- It stays in the sidebar until every step is done, instead of opening as a modal on login.
- "Invite your team" leaves the checklist unless the interviews say otherwise.

## Discussion
- Tom worried that a draft invoice without a bank account could confuse people when they send it. The send screen will ask for the bank account at that point.
- Sam wants the first step to mention the limits of the free plan. Not in this version.

## Action items
- [ ] Empty-state copy for the first screen (Priya)
- [ ] Analytics events for each checklist step (Tom, due Sep 30)
