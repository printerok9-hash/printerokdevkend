# Deploy the backend to Vercel

Use the **Express** framework preset. Set Root Directory to `backend` when importing a repository containing both frontend and backend folders; leave it at the repository root when importing the separate backend repository. Use the default build settings and a supported Node.js runtime (22.x or newer).

In the backend project's **Settings → Environment Variables**, add these for Production, then redeploy:

- `MONGODB_URI`: your hosted MongoDB connection string. Localhost and the development MongoDB server cannot be reached from Vercel. Allow the deployment to connect in your database provider's network settings.
- `ADMIN_EMAIL` and `ADMIN_PASSWORD`: credentials for initial admin creation; the password must have at least 14 characters.
- `SITE_ORIGIN`: the exact frontend origin, e.g. `https://your-frontend.vercel.app`, without a trailing slash.
- `FORMSUBMIT_EMAIL=printerok9@gmail.com`
- `CALENDLY_WEBHOOK_URL=https://printerokdevkend.vercel.app/api/webhooks/calendly`
- `CALENDLY_WEBHOOK_SIGNING_KEY`: the same signing key used when registering the Calendly webhook.

The git-ignored local `.env` file is not automatically deployed. Keep secrets in Vercel's environment settings.

In the frontend Vercel project, set `API_URL=https://printerokdevkend.vercel.app` and redeploy the frontend so its API rewrites use the hosted backend.

Check `/` for the API welcome response and `/api/health` for database connectivity. A 503 from health means the function runs but the database is unavailable. If you still get `FUNCTION_INVOCATION_FAILED`, open **Logs**, select the failed request, and inspect the exception/stack trace, not just its request summary.

Once the backend is reachable, follow [CALENDLY.md](./CALENDLY.md) to register the webhook. Webhook delivery also requires the callback route to be reachable without Vercel deployment-protection login.

Reference: [Express on Vercel](https://vercel.com/docs/frameworks/backend/express).
