---
topic: acme-crm
type: project
tags: [crm, flask, sqlite, api, sales, whatsapp]
entities: [Ana, Ricardo, Acme Corp]
status: active
created: 2026-01-15
last_verified: 2026-03-28
last_curated: 2026-03-28
curated_lines: 42
source_lines: 156
source_kb: 9.8
summary: >
  Custom CRM system for Acme Corp replacing Pipedrive. Flask/SQLite backend
  with WhatsApp webhook integration for quoting and sales pipeline management.
---

<!-- CURATED_START -->

## Architecture

- Backend: Flask + SQLite, single VPS deployment
- WhatsApp: webhook-based integration (replaced polling in March)
- Frontend: minimal admin panel, most interaction via WhatsApp and Telegram
- API: REST endpoints for deal creation, quote generation, contact lookup

## Current State

- MVP complete, 3 users onboarded (Ana, Ricardo, front desk)
- Processing ~500 WhatsApp messages/day through webhook
- Quote generation: 90% automated, 10% manual review for custom jobs
- SQLite handling current load fine (no need for Postgres yet)

## Key Decisions

- Flask over Django: Django too heavy for single-server deployment
- SQLite over Postgres: no replication needed at current scale, revisit at 10k deals
- Webhook over polling: polling was too slow at 500+ msgs/day
- No direct WhatsApp API: requires paid Business tier we don't have

## Contacts

- Ana: lead developer, handles backend
- Ricardo: sales lead, primary CRM user
- Front desk: uses quote lookup and customer search features

## Changelog

- 2026-03-28: [status] MVP complete. Was: in development. First 3 users onboarding.
- 2026-03-15: [whatsapp] Switched from polling to webhook. Was: polling every 30s. Polling couldn't keep up with 500+ msgs/day.
- 2026-02-20: [decision] Chose Flask/SQLite. Was: evaluating Django/Postgres. Django too heavy, Postgres unnecessary at our scale.
- 2026-01-15: [created] Project started. Replacing Pipedrive due to cost and customization limits.

<!-- CURATED_END -->

<!-- SOURCE_START -->

### 2026-03-28 — MVP launch and onboarding
> Discussed go-live timeline, user onboarding for Ana/Ricardo/front desk,
> and webhook performance under real load.

User: How's the CRM looking for launch?
Assistant: MVP is complete. The Flask backend is stable under load. The WhatsApp
webhook handled 500+ messages today with no drops. Ana, Ricardo, and the front
desk are onboarded. The quote generation flow is working — about 90% of quotes
go out automatically, the other 10% need manual review for custom fabrication jobs.
User: Any issues?
Assistant: One minor thing — the SQLite write lock occasionally causes a 200ms
delay when two quotes generate simultaneously. Not a problem at current volume,
but worth monitoring if we scale past 1000 messages/day.

### 2026-03-15 — WhatsApp integration: polling to webhook migration
> Migrated from 30-second polling to webhook-based message handling.
> Polling was dropping messages at high volume.

User: The WhatsApp polling is missing messages when it gets busy.
Assistant: At 500+ messages/day, the 30-second polling interval means we can
miss bursts. I'd recommend switching to webhooks — the messages arrive instantly
and we don't have to worry about the polling gap.
User: Do it.
Assistant: Done. Webhook endpoint configured at /api/whatsapp/webhook. Tested
with 50 rapid messages — all received within 1 second. The polling code is
still there but disabled.

<!-- SOURCE_END -->
