# Calendly dashboard sync

The website embeds the configured calendar automatically. Signed Calendly webhooks save new bookings to the admin Appointments list, including customer details, custom question answers and appointment time. Cancellations update the same record. Refresh the admin list to see new bookings.

## One-time setup

1. Use a Calendly plan that supports webhooks. Create a personal access token in Calendly's **Integrations & apps → API & Webhooks** with user-read, scheduled-event-read, and webhook-read/write access.
2. Add `CALENDLY_ACCESS_TOKEN` to `backend/.env`. Keep it on the backend only.
3. Add `CALENDLY_WEBHOOK_URL=https://YOUR-PUBLIC-BACKEND/api/webhooks/calendly`. Calendly cannot reach localhost; use your deployed backend or a development HTTPS tunnel.
4. Run `node register-calendly.cjs` from the backend directory. This subscribes your Calendly user to booking and cancellation events and saves a generated signing key if needed.
5. Ensure the backend serving the public URL uses that same `CALENDLY_WEBHOOK_SIGNING_KEY`, then restart it.
6. Make a test booking and refresh **Admin → Appointments**. Cancel the booking in Calendly and refresh to verify its status changes.

In Calendly's event questions, ask for phone number, postcode, printer brand and the printer problem to include these details in the dashboard. Absent answers display as not supplied. New webhook subscriptions do not import historical bookings.

Sources: [Calendly webhook setup](https://developer.calendly.com/docs/api-guides/receive-data-from-scheduled-events-in-real-time-with-webhook-subscriptions), [personal access tokens](https://developer.calendly.com/docs/authentication/how-to-authenticate-with-personal-access-tokens).
