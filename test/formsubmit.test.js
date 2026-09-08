const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sendNotification } = require("../formsubmit");
const lead = {
  _id: "test-id",
  type: "appointments",
  name: "Test Customer",
  email: "customer@example.com",
  phone: "+447700900123",
  brand: "Canon",
  postcode: "SW1A 1AA",
  problem: "Paper feed is jammed",
};

test("FormSubmit receives the customer details and reply address", async () => {
  await sendNotification(
    lead,
    "admin@example.com",
    "https://example.com",
    async (url, options) => {
      assert.equal(url, "https://formsubmit.co/ajax/admin%40example.com");
      assert.equal(options.method, "POST");
      const body = JSON.parse(options.body);
      assert.equal(body.postcode, lead.postcode);
      assert.equal(body._replyto, lead.email);
      assert.equal(body.message, lead.problem);
      assert.equal(body.requestId, "test-id");
      assert.equal(body._url, "https://example.com");
      assert.ok(options.signal);
      return { ok: true, json: async () => ({ success: "true" }) };
    },
  );
});

test("FormSubmit failures are not treated as accepted notifications", async () => {
  for (const response of [
    { ok: false },
    { ok: true, json: async () => ({ success: false }) },
    { ok: true, json: async () => ({ success: "false" }) },
    {
      ok: true,
      json: async () => {
        throw new Error("Invalid JSON");
      },
    },
  ])
    await assert.rejects(
      sendNotification(
        lead,
        "admin@example.com",
        "https://example.com",
        async () => response,
      ),
    );
  await assert.rejects(
    sendNotification(
      lead,
      "admin@example.com",
      "https://example.com",
      async () => {
        throw new Error("Timeout");
      },
    ),
  );
});
