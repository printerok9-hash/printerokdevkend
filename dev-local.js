const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
const dotenv = require("dotenv");
const { spawn } = require("node:child_process");
async function main() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath))
    fs.writeFileSync(
      envPath,
      `PORT=4001\nHOST=127.0.0.1\nNODE_ENV=development\nSITE_ORIGIN=http://localhost:3000\nMONGODB_URI=mongodb://127.0.0.1:27018/pinterok\nADMIN_EMAIL=printerok9@gmail.com\nADMIN_PASSWORD=${crypto.randomBytes(24).toString("base64url")}\nSMTP_HOST=\nSMTP_PORT=587\nSMTP_SECURE=false\nSMTP_USER=\nSMTP_PASS=\nSMTP_FROM=\nCALENDLY_WEBHOOK_SIGNING_KEY=\n`,
      { mode: 0o600 },
    );
  const config = dotenv.parse(fs.readFileSync(envPath));
  if (config.NODE_ENV === "production")
    throw new Error(
      "dev:local is for development only. Use a managed MongoDB database in production.",
    );
  const dbPath = path.join(__dirname, "data");
  fs.mkdirSync(dbPath, { recursive: true });
  const frontendEnv = path.join(__dirname, "../frontend/.env.local");
  if (!fs.existsSync(frontendEnv))
    fs.writeFileSync(
      frontendEnv,
      `API_URL=http://127.0.0.1:${config.PORT || 4001}\nNEXT_PUBLIC_SITE_URL=http://localhost:3000\nNEXT_PUBLIC_CALENDLY_URL=\n`,
    );
  const mongo = await MongoMemoryServer.create({
    binary: {
      downloadDir: path.join(
        __dirname,
        "node_modules/.cache/mongodb-memory-server",
      ),
    },
    instance: {
      port: 27018,
      ip: "127.0.0.1",
      dbPath,
      dbName: "pinterok",
      storageEngine: "wiredTiger",
    },
  });
  console.log(
    "Local MongoDB is running with persistent storage in backend/data.",
  );
  console.log("Admin email and generated password are in backend/.env.");
  const api = spawn(process.execPath, ["index.js"], {
    cwd: __dirname,
    env: { ...process.env, ...config },
    stdio: "inherit",
    windowsHide: true,
  });
  const stop = async () => {
    api.kill();
    await mongo.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  api.once("exit", async () => {
    await mongo.stop();
  });
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
