const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
process.env.CALENDLY_WEBHOOK_SIGNING_KEY = "isolated-test-signing-key";
process.env.SMTP_HOST = '';
process.env.NODE_ENV = 'test';
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
test("logout revokes database session", async () => {
  await agent.post("/api/admin/logout").set("Origin", origin).expect(200);
  await agent.get("/api/admin/stats").expect(401);
  assert.equal(await models.Session.countDocuments(), 0);
});
