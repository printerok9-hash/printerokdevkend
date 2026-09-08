const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const envPath = path.join(__dirname, ".env");
require("dotenv").config({ path: envPath, quiet: true });

async function main() {
  const token = process.env.CALENDLY_ACCESS_TOKEN;
  const rawUrl = process.env.CALENDLY_WEBHOOK_URL;
  if (!token || !rawUrl)
    throw new Error(
      "Set CALENDLY_ACCESS_TOKEN and CALENDLY_WEBHOOK_URL in backend/.env first.",
    );
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/api/webhooks/calendly"
  ) {
    throw new Error("Use a public HTTPS URL ending in /api/webhooks/calendly.");
  }
  async function api(route, body) {
    const response = await fetch(`https://api.calendly.com${route}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(
        `Calendly returned HTTP ${response.status}. Check your token permissions and webhook plan access.`,
      );
    return response.json();
  }
  const { resource: user } = await api("/users/me");
  const params = new URLSearchParams({
    organization: user.current_organization,
    user: user.uri,
    scope: "user",
    count: "100",
  });
  let route = `/webhook_subscriptions?${params}`;
  do {
    const result = await api(route);
    const existing = result.collection.find(
      (item) => item.callback_url === url.toString(),
    );
    if (existing) {
      console.log(
        `A subscription already exists (${existing.state}). Check its signing key and event subscriptions before creating another.`,
      );
      return;
    }
    const next = result.pagination?.next_page_token;
    if (next) params.set("page_token", next);
    route = next ? `/webhook_subscriptions?${params}` : null;
  } while (route);
  let key = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  if (!key) {
    key = crypto.randomBytes(32).toString("hex");
    const original = fs.existsSync(envPath)
      ? fs.readFileSync(envPath, "utf8")
      : "";
    const line = `CALENDLY_WEBHOOK_SIGNING_KEY=${key}`;
    fs.writeFileSync(
      envPath,
      /^CALENDLY_WEBHOOK_SIGNING_KEY=.*$/m.test(original)
        ? original.replace(/^CALENDLY_WEBHOOK_SIGNING_KEY=.*$/m, line)
        : `${original}\n${line}\n`,
    );
  }
  await api("/webhook_subscriptions", {
    url: url.toString(),
    organization: user.current_organization,
    user: user.uri,
    scope: "user",
    events: ["invitee.created", "invitee.canceled"],
    signing_key: key,
  });
  console.log(
    "Calendly webhook registered. Restart the backend with the signing key saved in backend/.env. New bookings and cancellations will sync.",
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
