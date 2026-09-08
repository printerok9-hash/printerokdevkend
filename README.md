# Pinterok backend API

Express API for repair enquiries, appointments, website content and the admin dashboard. Routes below reflect `index.js`.

- Backend: `https://printerokdevkend.vercel.app`
- Frontend: `https://www.pinterok.co.uk`
- The frontend forwards `/api/*` requests to the backend through its Next.js rewrite.
- Send JSON with `Content-Type: application/json`, except image uploads and Calendly webhook requests.

## Authentication and access

Admin endpoints require the `pinterok_session` cookie returned by login. Sessions last eight hours, are stored in MongoDB, and must belong to an existing admin. The cookie is HttpOnly, SameSite Strict, scoped to `/api/admin`, and Secure in production. There is no bearer-token login API.

Public appointment/enquiry creation, admin login, and all admin mutation requests require an `Origin` header matching the configured `SITE_ORIGIN`. In production this should be `https://www.pinterok.co.uk`. Browser clients should use the frontend `/api` proxy so cookies remain on the frontend domain.

Calendly uses signature authentication instead of an admin session. Public content lists return published records only.

## Public endpoints

| Method | Path | Purpose | Success response |
| --- | --- | --- | --- |
| GET | `/` | API welcome and health-check path | `200 { service, health }` |
| GET | `/api/health` | Database and email configuration status | `200 { database, emailConfigured }`; `503` when database unavailable |
| GET | `/api/public/posts` | Published blog posts, newest first | `200` array, maximum 100 |
| GET | `/api/public/services` | Published services, oldest first | `200` array, maximum 100 |
| GET | `/api/public/faqs` | Published FAQs, oldest first | `200` array, maximum 100 |
| GET | `/api/public/reviews` | Published reviews, newest first | `200` array, maximum 100 |
| POST | `/api/appointments` | Create an appointment request | `201 { message }` |
| POST | `/api/enquiries` | Create a repair enquiry | `201 { message }` |
| GET | `/api/images/:id` | Retrieve an uploaded image | `200` image bytes with Content-Type and cache headers |

Public lists do not accept search/pagination parameters. There is no public appointment list or public content-write endpoint. There is no individual-record GET or PUT route; website detail pages select content from lists. IDs must be 24 lowercase hexadecimal characters.

### Create an appointment or enquiry

| Field | Required | Validation |
| --- | --- | --- |
| `name` | Yes | Trimmed string, 2–100 characters |
| `phone` | Yes | 7–25 characters: digits, `+`, spaces, parentheses or hyphens |
| `email` | Yes | Valid email, maximum 254 characters |
| `brand` | Yes | Trimmed string, 1–80 characters |
| `postcode` | No | Trimmed string, 2–12 characters; omit if unavailable |
| `problem` | Yes | Trimmed string, 10–3000 characters |
| `preferredDate` | Appointments only | Actual date in `YYYY-MM-DD` format; today or later using Europe/London. Enquiries may omit it or send an empty string |
| `consent` | Yes | Literal string `"true"`, not a JSON boolean |
| `website` | No | Honeypot: must be empty if supplied |

Example enquiry body:

```json
{
  "name": "Example Customer",
  "phone": "+447700900123",
  "email": "customer@example.com",
  "brand": "Canon",
  "postcode": "SW1A 1AA",
  "problem": "The printer keeps showing a paper jam.",
  "consent": "true",
  "website": ""
}
```

Records are saved before FormSubmit notification delivery. A successful response confirms receipt of the request, not a confirmed appointment or successful email delivery. The website currently uses Calendly for bookings, but the public appointment-request API remains available.

## Admin authentication and utilities

| Method | Path | Access | Request / response |
| --- | --- | --- | --- |
| POST | `/api/admin/login` | Public, matching Origin | Body `{ "email": "...", "password": "..." }`; returns `200 { "ok": true }` and session cookie |
| GET | `/api/admin/me` | Admin | `200 { "authenticated": true }` |
| POST | `/api/admin/logout` | Admin | Revokes session and clears cookie; `200 { "ok": true }` |
| GET | `/api/admin/stats` | Admin | `200 { appointments, pending, completed, posts, messages }` counts |
| POST | `/api/admin/upload` | Admin | Multipart field `image`; JPEG, PNG or WebP, up to 5 MiB; `201 { "url": "/api/images/<id>" }` |

Login accepts an email up to 254 characters and a password of 1–128 characters. Initial admin creation from environment settings requires a password of at least 14 characters. In stats, `pending` counts pending, confirmed and in-progress appointments; `messages` counts enquiries.

## Admin collection endpoints

Every endpoint in this table requires admin login. Replace `:id` with the record ID.

| Collection | List (GET) | Create (POST) | Edit (PATCH) | Delete (DELETE) |
| --- | --- | --- | --- | --- |
| Appointments | `/api/admin/appointments` | Not supported (`405`); use public creation | `/api/admin/appointments/:id` | `/api/admin/appointments/:id` |
| Enquiries | `/api/admin/enquiries` | Not supported (`405`); use public creation | `/api/admin/enquiries/:id` | `/api/admin/enquiries/:id` |
| Blog posts | `/api/admin/posts` | `/api/admin/posts` | `/api/admin/posts/:id` | `/api/admin/posts/:id` |
| Services | `/api/admin/services` | `/api/admin/services` | `/api/admin/services/:id` | `/api/admin/services/:id` |
| FAQs | `/api/admin/faqs` | `/api/admin/faqs` | `/api/admin/faqs/:id` | `/api/admin/faqs/:id` |
| Reviews | `/api/admin/reviews` | `/api/admin/reviews` | `/api/admin/reviews/:id` | `/api/admin/reviews/:id` |

Content creation returns `201` with the saved record. Edits return `200` with the updated record. Deletion returns `200 { "ok": true }`. Delete endpoints still exist even though the dashboard no longer displays Delete buttons.

### List, search, filter and paginate

Supply `page` to enable pagination and filters:

```text
GET /api/admin/appointments?page=1&q=Canon%20SW1A&status=pending&sort=newest
GET /api/admin/posts?page=1&published=true
```

| Query | Values / meaning |
| --- | --- |
| `page` | Integer 1–1,000,000; 10 records per page; excessive page numbers clamp to the last page |
| `q` | Up to 200 characters; case-insensitive literal search across the complete selected collection before pagination |
| `status` | Leads only: `pending`, `confirmed`, `in-progress`, `completed`, `cancelled` |
| `brand` | Leads only: exact brand, up to 80 characters |
| `notification` | Leads only: exact notification status, up to 40 characters; supported by API although hidden in the dashboard |
| `published` | Content only: string `true` or `false` |
| `sort` | `newest` (default) or `oldest`, by creation time |

Search terms are combined with AND; each term can match a different field. Lead search covers name, email, phone, postcode, brand, problem, preferred date, status and notification. Content search covers title, slug, description, content, category, label and location. Empty filters are ignored.

Paginated responses contain `{ items, total, page, pages, brands, notifications }`. Filter options cover the entire selected lead collection; content collections return empty option arrays. Empty results return `items: []`, `total: 0`, `page: 1`, `pages: 1`.

Without `page`, the endpoint returns a plain array of up to 500 records, newest first, and ignores search/filter parameters. Admin lists include unpublished content.

### Edit appointments and enquiries

`status` is required and must be one of `pending`, `confirmed`, `in-progress`, `completed`, `cancelled`. Other editable fields are optional: `name`, `email`, `phone`, `brand`, `postcode`, `problem`, `preferredDate`.

Field validation follows public creation, except postcode and preferred date may be cleared with `""`, and historical preferred dates are allowed. Dates must still be real calendar dates. Collection/type, notification status and Calendly metadata cannot be changed through this endpoint.

```json
{
  "status": "in-progress",
  "brand": "Epson",
  "problem": "Technician is investigating the paper feed issue."
}
```

### Create or edit posts, services, FAQs and reviews

POST and PATCH use the same schema. `title` and `slug` are required on both. On PATCH, omitted optional fields receive the defaults below, so submit the complete content record to preserve those values.

| Field | Validation / default |
| --- | --- |
| `title` | Required, trimmed string, 2–200 characters |
| `slug` | Required, lowercase letters/digits separated by single hyphens, maximum 200 characters; unique within collection |
| `description` | Maximum 500 characters; default `""` |
| `content` | Maximum 60,000 characters; default `""` |
| `category`, `label` | Maximum 80 characters each; default `""` |
| `image` | `/api/images/<24-character-id>` or `""`; default `""` |
| `location` | Maximum 100 characters; default `""` |
| `rating` | Integer 1–5; default `5` |
| `published` | Boolean; default `false` |

### Retry an email notification

| Method | Path | Access |
| --- | --- | --- |
| POST | `/api/admin/appointments/:id/retry-email` | Admin |
| POST | `/api/admin/enquiries/:id/retry-email` | Admin |

No request body is required. Returns `200 { notification }`; inspect the notification value because a delivery attempt can fail. Returns `503` if FormSubmit is not configured. These routes remain available even though retry controls are hidden in the dashboard. They send through FormSubmit, including when invoked manually for a Calendly record.

## Calendly webhook

`POST /api/webhooks/calendly`

- Requires the `Calendly-Webhook-Signature` header, formatted `t=<unix-seconds>,v1=<hex-signature>`.
- Verifies HMAC-SHA256 of `<timestamp>.<raw-request-body>` using `CALENDLY_WEBHOOK_SIGNING_KEY`, with a 180-second timestamp tolerance.
- Accepts raw `application/json`, up to 100 KiB. Do not reserialize the payload before verifying its signature.
- Payload requires `payload.uri`, `payload.email` and `payload.name`.
- `invitee.created` inserts an appointment with confirmed status; `invitee.canceled` records cancelled status. Duplicate delivery does not create duplicate records, and a later creation delivery does not undo cancellation.
- Customer question answers, available contact details, start time and timezone are saved for the dashboard. These bookings do not automatically trigger FormSubmit notifications.
- Returns `200` for accepted events (including duplicates), `400` for invalid data, `401` for invalid signatures, and `503` when the signing key/database is unavailable. Other event types with the required payload fields are acknowledged without changes.

See [Calendly setup](CALENDLY.md) for registration and public URL requirements. This webhook does not import historical bookings.

## Errors and limits

| Status | Meaning |
| --- | --- |
| 400 | Invalid input, ID, date, or upload |
| 401 | Missing/expired admin session, deleted admin account, invalid credentials, or invalid webhook signature |
| 403 | Origin rejected |
| 404 | Unknown route, collection, or record |
| 405 | Admin-side lead creation is unsupported |
| 409 | Duplicate content slug |
| 429 | Rate limit exceeded |
| 500 | Unexpected backend error |
| 503 | Database or required integration configuration unavailable |

Most validation and application errors return `{ "error": "..." }`; some status-only responses use Express plain text. JSON bodies are limited to 100 KiB. General `/api` traffic is limited to 150 requests per minute per client IP; lead creation has an additional shared limit of 8 requests per 15 minutes, and login limits unsuccessful attempts to 5 per 15 minutes. The Calendly webhook is registered before the general API limiter and uses signature verification.

## Run and deploy

```sh
npm install
npm run dev
npm test
```

Configure `.env` from `.env.example` without committing secrets. `npm run dev:local` runs the development MongoDB helper; production requires a hosted database. See [deployment instructions](DEPLOYMENT.md) for Vercel configuration.
