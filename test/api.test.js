const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
process.env.CALENDLY_WEBHOOK_SIGNING_KEY = "isolated-test-signing-key";
process.env.FORMSUBMIT_EMAIL = "";
process.env.NODE_ENV = "test";
const { app, models, mongoose } = require("../index");
let mongo, agent;
const origin = "http://localhost:3000";
const lead = {
  name: "Test Customer",
  phone: "+447700900123",
  email: "test@example.com",
  brand: "Canon",
  problem: "Printer is not connecting to the network",
  preferredDate: "2099-01-01",
  consent: "true",
  website: "",
};
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all(Object.values(models).map((m) => m.init()));
  await models.Admin.create({
    email: "admin@example.com",
    passwordHash: await bcrypt.hash("Test-only-password-428!", 4),
  });
  agent = request.agent(app);
});
after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
test("unauthenticated admin requests are rejected", async () => {
  await request(app).get("/api/admin/stats").expect(401);
  await request(app)
    .post("/api/admin/posts")
    .set("Origin", origin)
    .send({})
    .expect(401);
});

test("Vercel entrypoint exports a callable Express app and serves root and health", async () => {
  const entry = require("../index");
  assert.equal(typeof entry, "function");
  assert.equal(entry, entry.app);
  const root = await request(entry).get("/").expect(200);
  assert.equal(root.body.service, "Pinterok API");
  const health = await request(entry).get("/api/health").expect(200);
  assert.equal(health.body.database, "connected");
});
test("lead validation rejects spam, missing consent, impossible dates and cross-origin requests", async () => {
  await request(app)
    .post("/api/enquiries")
    .set("Origin", "https://untrusted.example")
    .send(lead)
    .expect(403);
  await request(app)
    .post("/api/enquiries")
    .set("Origin", origin)
    .send({ ...lead, consent: "false" })
    .expect(400);
  await request(app)
    .post("/api/enquiries")
    .set("Origin", origin)
    .send({ ...lead, website: "spam" })
    .expect(400);
  await request(app)
    .post("/api/appointments")
    .set("Origin", origin)
    .send({ ...lead, preferredDate: "2099-02-31" })
    .expect(400);
});
test("enquiries persist before notifications and do not claim confirmed appointments", async () => {
  const r = await request(app)
    .post("/api/enquiries")
    .set("Origin", origin)
    .send(lead)
    .expect(201);
  assert.match(r.body.message, /not confirmed/);
  const stored = await models.Lead.findOne({
    email: lead.email,
    type: "enquiries",
  });
  assert.ok(stored);
  assert.equal(stored.status, "pending");
  assert.equal(stored.problem, lead.problem);
  assert.equal(stored.postcode, undefined);
});
test("admin login uses an HttpOnly SameSite cookie; sessions can be revoked", async () => {
  await agent
    .post("/api/admin/login")
    .set("Origin", origin)
    .send({ email: "admin@example.com", password: "wrong" })
    .expect(401);
  const r = await agent
    .post("/api/admin/login")
    .set("Origin", origin)
    .send({ email: "admin@example.com", password: "Test-only-password-428!" })
    .expect(200);
  assert.match(r.headers["set-cookie"][0], /HttpOnly/);
  assert.match(r.headers["set-cookie"][0], /SameSite=Strict/);
  await agent.get("/api/admin/me").expect(200);
  await agent
    .post("/api/admin/logout")
    .set("Origin", "https://untrusted.example")
    .expect(403);
});
test("appointment creation, status updates, statistics and deletion work", async () => {
  await request(app)
    .post("/api/appointments")
    .set("Origin", origin)
    .send(lead)
    .expect(201);
  const { body } = await agent.get("/api/admin/appointments").expect(200);
  assert.equal(body.length, 1);
  await agent
    .patch(`/api/admin/appointments/${body[0]._id}`)
    .set("Origin", origin)
    .send({ status: "completed" })
    .expect(200);
  const stats = await agent.get("/api/admin/stats").expect(200);
  assert.equal(stats.body.completed, 1);
  assert.equal(stats.body.pending, 0);
  await agent
    .delete(`/api/admin/appointments/${body[0]._id}`)
    .set("Origin", origin)
    .expect(200);
  assert.equal(await models.Lead.countDocuments({ type: "appointments" }), 0);
});
test("draft and published content CRUD respects public visibility and deletion", async () => {
  for (const kind of ["posts", "services", "faqs", "reviews"]) {
    const content = {
      title: `Test ${kind}`,
      slug: `test-${kind}`,
      content: "A useful explanation.",
      published: false,
    };
    const created = await agent
      .post(`/api/admin/${kind}`)
      .set("Origin", origin)
      .send(content)
      .expect(201);
    let pub = await request(app).get(`/api/public/${kind}`).expect(200);
    assert.equal(pub.body.length, 0);
    await agent
      .patch(`/api/admin/${kind}/${created.body._id}`)
      .set("Origin", origin)
      .send({ ...content, published: true })
      .expect(200);
    pub = await request(app).get(`/api/public/${kind}`).expect(200);
    assert.equal(pub.body.length, 1);
    await agent
      .delete(`/api/admin/${kind}/${created.body._id}`)
      .set("Origin", origin)
      .expect(200);
    pub = await request(app).get(`/api/public/${kind}`).expect(200);
    assert.equal(pub.body.length, 0);
  }
});
test("uploads reject SVG and store validated raster bytes in MongoDB", async () => {
  await agent
    .post("/api/admin/upload")
    .set("Origin", origin)
    .attach("image", Buffer.from('<svg onload="alert(1)"/>'), "unsafe.svg")
    .expect(400);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+X8AAAAASUVORK5CYII=",
    "base64",
  );
  const r = await agent
    .post("/api/admin/upload")
    .set("Origin", origin)
    .attach("image", png, "pixel.png")
    .expect(201);
  const img = await request(app).get(r.body.url).expect(200);
  assert.match(img.headers["content-type"], /image\/png/);
  assert.equal(img.headers["x-content-type-options"], "nosniff");
});
test("Calendly signatures are verified and repeated events are idempotent", async () => {
  const payload = JSON.stringify({
    event: "invitee.created",
    payload: {
      uri: "https://api.calendly.com/scheduled_events/test/invitees/test",
      email: "calendar@example.com",
      name: "Calendar Test",
      scheduled_event: { start_time: "2099-01-01T10:00:00Z" },
    },
  });
  await request(app)
    .post("/api/webhooks/calendly")
    .set("Content-Type", "application/json")
    .send(payload)
    .expect(401);
  const t = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac("sha256", process.env.CALENDLY_WEBHOOK_SIGNING_KEY)
    .update(`${t}.${payload}`)
    .digest("hex");
  for (let i = 0; i < 2; i++)
    await request(app)
      .post("/api/webhooks/calendly")
      .set("Content-Type", "application/json")
      .set("Calendly-Webhook-Signature", `t=${t},v1=${signature}`)
      .send(payload)
      .expect(200);
  assert.equal(
    await models.Lead.countDocuments({ email: "calendar@example.com" }),
    1,
  );
});
test("Calendly sync preserves answers, time and cancellation across duplicate deliveries", async () => {
  const data = {
    uri: "https://api.calendly.com/scheduled_events/sync/invitees/sync",
    name: "Sync Customer",
    email: "sync@example.com",
    timezone: "Asia/Kolkata",
    scheduled_event: { start_time: "2099-01-01T10:00:00Z" },
    questions_and_answers: [
      { question: "Phone number", answer: "+447700900123" },
      { question: "Postcode", answer: "SW1A 1AA" },
      { question: "Printer brand", answer: "Epson" },
      { question: "Printer problem", answer: "Paper keeps jamming" },
    ],
  };
  async function deliver(
    event,
    timestamp = String(Math.floor(Date.now() / 1000)),
    expected = 200,
  ) {
    const body = JSON.stringify({ event, payload: data });
    const signature = crypto
      .createHmac("sha256", process.env.CALENDLY_WEBHOOK_SIGNING_KEY)
      .update(timestamp + "." + body)
      .digest("hex");
    await request(app)
      .post("/api/webhooks/calendly")
      .set("Content-Type", "application/json")
      .set("Calendly-Webhook-Signature", "t=" + timestamp + ",v1=" + signature)
      .send(body)
      .expect(expected);
  }
  await deliver("invitee.created", "NaN", 401);
  await deliver("invitee.created");
  let saved = await models.Lead.findOne({ externalId: data.uri });
  assert.equal(saved.postcode, "SW1A 1AA");
  assert.equal(saved.brand, "Epson");
  assert.equal(saved.calendlyStartTime, data.scheduled_event.start_time);
  assert.equal(saved.preferredDate, "2099-01-01");
  assert.match(saved.problem, /Paper keeps jamming/);
  await deliver("invitee.canceled");
  await deliver("invitee.created");
  saved = await models.Lead.findOne({ externalId: data.uri });
  assert.equal(saved.status, "cancelled");
  assert.equal(await models.Lead.countDocuments({ externalId: data.uri }), 1);
  await models.Lead.deleteOne({ externalId: data.uri });
  await deliver("invitee.canceled");
  await deliver("invitee.created");
  saved = await models.Lead.findOne({ externalId: data.uri });
  assert.equal(saved.status, "cancelled");
  await models.Lead.deleteOne({ externalId: data.uri });
});

test("admin search covers the full dataset, filters before paging and clamps empty pages", async () => {
  const rows = Array.from({ length: 511 }, (_, i) => ({
    type: "appointments",
    name: `Pagination fixture ${i}`,
    email: "pagination@example.com",
    phone: "+447700900123",
    postcode: "SW1A 1AA",
    brand: i === 0 ? "Rare brand" : "Canon",
    problem: i === 0 ? "Unique [scanner] issue" : "Paper feed issue",
    status: i % 2 ? "completed" : "pending",
    notification: "sent",
    createdAt: new Date(2020, 0, 1, 0, 0, i),
  }));
  await models.Lead.insertMany(rows);
  try {
    const first = (
      await agent
        .get("/api/admin/appointments")
        .query({ page: 1, q: "pagination@example.com" })
        .expect(200)
    ).body;
    assert.equal(first.items.length, 10);
    assert.equal(first.total, 511);
    assert.equal(first.pages, 52);
    const second = (
      await agent
        .get("/api/admin/appointments")
        .query({ page: 2, q: "pagination@example.com" })
        .expect(200)
    ).body;
    assert.ok(
      second.items.every(
        (item) => !first.items.some((other) => other._id === item._id),
      ),
    );
    const found = (
      await agent
        .get("/api/admin/appointments")
        .query({
          page: 1,
          q: "UNIQUE [scanner] SW1A",
          brand: "Rare brand",
          status: "pending",
          notification: "sent",
        })
        .expect(200)
    ).body;
    assert.equal(found.total, 1);
    assert.equal(found.items[0].name, "Pagination fixture 0");
    const clamped = (
      await agent
        .get("/api/admin/appointments")
        .query({ page: 999, q: "pagination@example.com" })
        .expect(200)
    ).body;
    assert.equal(clamped.page, 52);
    assert.equal(clamped.items.length, 1);
    const empty = (
      await agent
        .get("/api/admin/appointments")
        .query({ page: 20, q: "does-not-exist-unique" })
        .expect(200)
    ).body;
    assert.equal(empty.total, 0);
    assert.equal(empty.page, 1);
    await agent.get("/api/admin/appointments").query({ page: -1 }).expect(400);
    await agent
      .get("/api/admin/appointments")
      .query({ page: 1, status: "invalid" })
      .expect(400);
    const content = await models.Content.create({
      kind: "posts",
      title: "Pagination draft fixture",
      published: false,
    });
    try {
      const drafts = (
        await agent
          .get("/api/admin/posts")
          .query({ page: 1, q: "Pagination draft", published: "false" })
          .expect(200)
      ).body;
      assert.equal(drafts.total, 1);
      const published = (
        await agent
          .get("/api/admin/posts")
          .query({ page: 1, q: "Pagination draft", published: "true" })
          .expect(200)
      ).body;
      assert.equal(published.total, 0);
    } finally {
      await models.Content.deleteOne({ _id: content._id });
    }
  } finally {
    await models.Lead.deleteMany({ email: "pagination@example.com" });
  }
});

test("admin can edit customer requests with validation and collection isolation", async () => {
  const record = await models.Lead.create({ ...lead, type: "enquiries" });
  try {
    await agent
      .patch(`/api/admin/enquiries/${record._id}`)
      .set("Origin", origin)
      .send({
        name: "Updated Customer",
        phone: "+447700900456",
        email: "updated@example.com",
        postcode: "SW1A 1AA",
        brand: "Epson",
        problem: "Paper keeps jamming in the feeder",
        preferredDate: "2020-01-01",
        status: "confirmed",
        type: "appointments",
        notification: "sent",
      })
      .expect(200);
    const saved = await models.Lead.findById(record._id);
    assert.equal(saved.name, "Updated Customer");
    assert.equal(saved.postcode, "SW1A 1AA");
    assert.equal(saved.brand, "Epson");
    assert.equal(saved.status, "confirmed");
    assert.equal(saved.type, "enquiries");
    assert.equal(saved.notification, "pending");
    await agent
      .patch(`/api/admin/enquiries/${record._id}`)
      .set("Origin", origin)
      .send({ status: "pending", email: "invalid" })
      .expect(400);
    await agent
      .patch(`/api/admin/enquiries/${record._id}`)
      .set("Origin", origin)
      .send({ status: "pending", preferredDate: "2026-02-31" })
      .expect(400);
    await agent
      .patch(`/api/admin/appointments/${record._id}`)
      .set("Origin", origin)
      .send({ status: "pending" })
      .expect(404);
    await agent
      .patch(`/api/admin/enquiries/${record._id}`)
      .set("Origin", origin)
      .send({ status: "completed", postcode: "", preferredDate: "" })
      .expect(200);
  } finally {
    await models.Lead.deleteOne({ _id: record._id });
  }
});

test("logout revokes database session", async () => {
  await agent.post("/api/admin/logout").set("Origin", origin).expect(200);
  await agent.get("/api/admin/stats").expect(401);
  assert.equal(await models.Session.countDocuments(), 0);
});
