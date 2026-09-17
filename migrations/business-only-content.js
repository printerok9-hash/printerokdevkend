const path = require("node:path");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.join(__dirname, "../.env"), quiet: true });
const changes = require("./business-only-content.json");

// Dry-run by default. Update only exact original seed values, never custom copy.
async function migrate() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required.");
  const apply = process.argv.includes("--apply");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  const collection = mongoose.connection.collection("contents");
  for (const change of changes) {
    const key = { kind: change.kind, slug: change.slug };
    const record = await collection.findOne(key);
    if (!record) { console.log("Missing record:", change.kind, change.slug); continue; }
    for (const [field, values] of Object.entries(change.fields)) {
      if (record[field] === values.after) continue;
      if (record[field] !== values.before) {
        console.log("Manual review needed:", change.kind, change.slug, field);
        process.exitCode = 2;
        continue;
      }
      if (apply) {
        const result = await collection.updateOne(
          { ...key, [field]: values.before },
          { $set: { [field]: values.after, updatedAt: new Date() } },
        );
        console.log(result.modifiedCount ? "Updated:" : "Changed concurrently; review:", change.kind, change.slug, field);
        if (!result.modifiedCount) process.exitCode = 2;
      } else console.log("Would update:", change.kind, change.slug, field);
    }
  }
  // Report remaining consumer service wording; never hide it from site visitors.
  for await (const record of collection.find({ published: true })) {
    if ([record.title, record.description, record.content, record.label].some(
      value => typeof value === "string" && /\b(homes?|households?|residential|domestic)\b/i.test(value),
    )) console.log("Review published wording (including legitimate exclusions):", record.kind, record.slug);
  }
  console.log(apply ? "Migration finished. Review all customised content before advertising." : "Dry run complete. Use --apply to update matching seed values.");
}

migrate().catch(error => {
  console.error(error.message === "MONGODB_URI is required." ? error.message : "Migration failed; check database access and retry.");
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
