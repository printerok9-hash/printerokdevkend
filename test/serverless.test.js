const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

test("serverless requests initialize MongoDB without starting a port listener", async () => {
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.ADMIN_EMAIL = "";
  process.env.ADMIN_PASSWORD = "";
  process.env.FORMSUBMIT_EMAIL = "";
  process.env.VERCEL = "1";
  const entry = require("../index");
  try {
    assert.equal(entry.mongoose.connection.readyState, 0);
    await request(entry).get("/").expect(200);
    const results = await Promise.all([
      request(entry).get("/api/health").expect(200),
      request(entry).get("/api/health").expect(200),
    ]);
    for (const result of results)
      assert.equal(result.body.database, "connected");
    assert.ok((await entry.models.Content.countDocuments()) > 0);
  } finally {
    await entry.mongoose.disconnect();
    await mongo.stop();
  }
});
