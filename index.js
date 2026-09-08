require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const { sendNotification } = require("./formsubmit");
const multer = require("multer");
const { z } = require("zod");
const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY)
  app.set("trust proxy", Number(process.env.TRUST_PROXY));
app.use(helmet());
const production = process.env.NODE_ENV === "production";
const origin = process.env.SITE_ORIGIN || "http://localhost:3000";
const Lead = mongoose.model(
  "Lead",
  new mongoose.Schema(
    {
      type: {
        type: String,
        enum: ["appointments", "enquiries"],
        required: true,
      },
      name: String,
      phone: String,
      email: String,
      brand: String,
      postcode: String,
      problem: String,
      preferredDate: String,
      calendlyStartTime: String,
      calendlyTimezone: String,
      status: {
        type: String,
        enum: ["pending", "confirmed", "in-progress", "completed", "cancelled"],
        default: "pending",
      },
      notification: { type: String, default: "pending" },
      externalId: { type: String, unique: true, sparse: true },
    },
    { timestamps: true },
  ),
);
const Content = mongoose.model(
  "Content",
  new mongoose.Schema(
    {
      kind: {
        type: String,
        enum: ["posts", "services", "faqs", "reviews"],
        required: true,
      },
      title: String,
      slug: String,
      description: String,
      content: String,
      category: String,
      label: String,
      image: String,
      location: String,
      rating: Number,
      published: { type: Boolean, default: false },
    },
    { timestamps: true },
  ),
);
Content.schema.index({ kind: 1, slug: 1 }, { unique: true });
const Admin = mongoose.model(
  "Admin",
  new mongoose.Schema({
    email: { type: String, unique: true },
    passwordHash: String,
  }),
);
const Setting = mongoose.model(
  "Setting",
  new mongoose.Schema({ _id: String, done: Boolean }),
);
const Session = mongoose.model(
  "Session",
  new mongoose.Schema({
    hash: { type: String, unique: true },
    adminId: mongoose.Schema.Types.ObjectId,
    expires: { type: Date, index: { expires: 0 } },
  }),
);
const Asset = mongoose.model(
  "Asset",
  new mongoose.Schema({ data: Buffer, mime: String }, { timestamps: true }),
);
const leadSchema = z.object({
  name: z.string().trim().min(2).max(100),
  phone: z.string().regex(/^[+0-9 ()-]{7,25}$/),
  email: z.string().email().max(254),
  brand: z.string().trim().min(1).max(80),
  postcode: z.string().trim().min(2).max(12).optional(),
  problem: z.string().trim().min(10).max(3000),
  preferredDate: z
    .string()
    .regex(/^$|^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  consent: z.literal("true"),
  website: z.string().max(0).optional(),
});
const contentSchema = z.object({
  title: z.string().trim().min(2).max(200),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(200),
  description: z.string().max(500).default(""),
  content: z.string().max(60000).default(""),
  category: z.string().max(80).default(""),
  label: z.string().max(80).default(""),
  image: z
    .string()
    .regex(/^$|^\/api\/images\/[a-f0-9]{24}$/)
    .default(""),
  location: z.string().max(100).default(""),
  rating: z.number().int().min(1).max(5).default(5),
  published: z.boolean().default(false),
});
function connected(req, res, next) {
  if (mongoose.connection.readyState !== 1)
    return res.status(503).json({
      error:
        "The booking system is temporarily unavailable. Please call +44 7441448082.",
    });
  next();
}
function sameOrigin(req, res, next) {
  if (req.get("origin") !== origin)
    return res.status(403).json({ error: "Request origin rejected." });
  next();
}
function validId(req, res, next) {
  if (!/^[a-f0-9]{24}$/.test(req.params.id))
    return res.status(400).json({ error: "Invalid ID." });
  next();
}
async function auth(req, res, next) {
  const token = req.cookies.pinterok_session;
  if (!token) return res.status(401).json({ error: "Please sign in." });
  const session = await Session.findOne({
    hash: crypto.createHash("sha256").update(token).digest("hex"),
    expires: { $gt: new Date() },
  });
  if (!session)
    return res.status(401).json({ error: "Session expired. Please sign in." });
  req.session = session;
  next();
}
const notificationEmail = process.env.FORMSUBMIT_EMAIL || "";
async function notifyLead(lead) {
  if (!notificationEmail) {
    lead.notification = "not-configured";
    await lead.save();
    return;
  }
  try {
    await sendNotification(lead, notificationEmail, origin);
    lead.notification = "submitted";
  } catch {
    lead.notification = "failed";
    console.error(
      "Lead email notification failed; request retained in dashboard.",
    );
  }
  await lead.save();
}
app.post(
  "/api/webhooks/calendly",
  express.raw({ type: "application/json", limit: "100kb" }),
  connected,
  async (req, res) => {
    const secret = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
    if (!secret)
      return res.status(503).json({ error: "Webhook not configured." });
    const sig = req.get("Calendly-Webhook-Signature") || "";
    const entries = sig.split(",").map((v) => v.trim().split("="));
    const timestamp = entries.find((v) => v[0] === "t")?.[1];
    const signatures = entries.filter((v) => v[0] === "v1").map((v) => v[1]);
    if (
      !timestamp ||
      !/^\d+$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 180
    )
      return res.sendStatus(401);
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}.${req.body.toString("utf8")}`)
      .digest("hex");
    if (
      !signatures.some(
        (v) =>
          /^[a-f0-9]{64}$/.test(v) &&
          crypto.timingSafeEqual(
            Buffer.from(v, "hex"),
            Buffer.from(expected, "hex"),
          ),
      )
    )
      return res.sendStatus(401);
    let event;
    try {
      event = JSON.parse(req.body);
    } catch {
      return res.sendStatus(400);
    }
    const p = event.payload;
    if (!p?.uri || !p?.email || !p?.name) return res.sendStatus(400);
    if (!["invitee.created", "invitee.canceled"].includes(event.event))
      return res.sendStatus(200);
    const answers = Array.isArray(p.questions_and_answers)
      ? p.questions_and_answers
      : [];
    const answer = (pattern) =>
      String(
        answers.find((item) => pattern.test(String(item.question)))?.answer ||
          "",
      );
    const details = answers
      .map((item) => `${item.question}: ${item.answer}`)
      .join("\n");
    const startTime = String(p.scheduled_event?.start_time || "");
    const cancelled = event.event === "invitee.canceled";
    try {
      const fields = {
        type: "appointments",
        name: String(p.name).slice(0, 100),
        email: String(p.email).slice(0, 254),
        phone: String(
          p.text_reminder_number ||
            answer(/phone|mobile|contact number/i) ||
            "Not supplied",
        ).slice(0, 25),
        brand: (answer(/brand/i) || "Via Calendly").slice(0, 80),
        postcode: (answer(/post\s*code|postal|zip/i) || "Not supplied").slice(
          0,
          12,
        ),
        problem: (
          details ||
          "Appointment booked via Calendly. Check Calendly for event details."
        ).slice(0, 3000),
        preferredDate: startTime.slice(0, 10),
        calendlyStartTime: startTime,
        calendlyTimezone: String(p.timezone || "UTC"),
        status: cancelled ? "cancelled" : "confirmed",
        externalId: p.uri,
        notification: "managed-by-calendly",
      };
      const { status, ...insertFields } = fields;
      await Lead.updateOne(
        { externalId: p.uri },
        cancelled
          ? { $setOnInsert: insertFields, $set: { status } }
          : { $setOnInsert: fields },
        { upsert: true, runValidators: true },
      );
      res.sendStatus(200);
    } catch (e) {
      if (e.code === 11000) return res.sendStatus(200);
      throw e;
    }
  },
);
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.get("/api/health", (req, res) =>
  res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({
    database:
      mongoose.connection.readyState === 1 ? "connected" : "unavailable",
    emailConfigured: !!notificationEmail,
  }),
);
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: 150,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
app.get("/api/public/:kind", connected, async (req, res) => {
  if (!["posts", "services", "faqs", "reviews"].includes(req.params.kind))
    return res.sendStatus(404);
  res.json(
    await Content.find({ kind: req.params.kind, published: true })
      .sort({
        createdAt: ["services", "faqs"].includes(req.params.kind) ? 1 : -1,
      })
      .limit(100)
      .lean(),
  );
});
const leadLimit = rateLimit({
  windowMs: 15 * 60000,
  limit: 8,
  message: { error: "Too many requests. Please call us or try again later." },
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
app.post(
  "/api/:kind",
  (req, res, next) =>
    ["appointments", "enquiries"].includes(req.params.kind)
      ? next()
      : next("route"),
  sameOrigin,
  leadLimit,
  connected,
  async (req, res) => {
    const data = leadSchema.parse(req.body);
    if (req.params.kind === "appointments" && !data.preferredDate)
      return res.status(400).json({ error: "Please select a preferred date." });
    if (data.preferredDate) {
      const date = new Date(`${data.preferredDate}T12:00:00Z`);
      if (
        Number.isNaN(date.getTime()) ||
        date.toISOString().slice(0, 10) !== data.preferredDate ||
        data.preferredDate <
          new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" })
      )
        return res
          .status(400)
          .json({ error: "Please select a valid current or future date." });
    }
    const { consent, website, ...fields } = data;
    const lead = await Lead.create({ ...fields, type: req.params.kind });
    res.status(201).json({
      message:
        "Thank you. Our team will contact you to discuss your printer and confirm availability. Your appointment is not confirmed until we contact you.",
    });
    void notifyLead(lead).catch(() =>
      console.error("Notification status could not be saved."),
    );
  },
);
app.get("/api/images/:id", connected, validId, async (req, res) => {
  const asset = await Asset.findById(req.params.id);
  if (!asset) return res.sendStatus(404);
  res
    .set({
      "Content-Type": asset.mime,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    })
    .send(asset.data);
});
app.post(
  "/api/admin/login",
  sameOrigin,
  rateLimit({
    windowMs: 15 * 60000,
    limit: 5,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many attempts. Try again in 15 minutes." },
  }),
  connected,
  async (req, res) => {
    const input = z
      .object({
        email: z.string().email().max(254),
        password: z.string().min(1).max(128),
      })
      .parse(req.body);
    const admin = await Admin.findOne({ email: input.email.toLowerCase() });
    if (!admin || !(await bcrypt.compare(input.password, admin.passwordHash)))
      return res.status(401).json({ error: "Email or password is incorrect." });
    const token = crypto.randomBytes(32).toString("hex");
    await Session.create({
      hash: crypto.createHash("sha256").update(token).digest("hex"),
      adminId: admin._id,
      expires: new Date(Date.now() + 8 * 3600000),
    });
    res.cookie("pinterok_session", token, {
      httpOnly: true,
      secure: production,
      sameSite: "strict",
      path: "/api/admin",
      maxAge: 8 * 3600000,
    });
    res.json({ ok: true });
  },
);
app.use("/api/admin", connected, auth, (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!["GET", "HEAD"].includes(req.method)) return sameOrigin(req, res, next);
  next();
});
app.get("/api/admin/me", (req, res) => res.json({ authenticated: true }));
app.post("/api/admin/logout", async (req, res) => {
  await Session.deleteOne({ _id: req.session._id });
  res
    .clearCookie("pinterok_session", {
      path: "/api/admin",
      httpOnly: true,
      secure: production,
      sameSite: "strict",
    })
    .json({ ok: true });
});
app.get("/api/admin/stats", async (req, res) => {
  const [appointments, pending, completed, posts, messages] = await Promise.all(
    [
      Lead.countDocuments({ type: "appointments" }),
      Lead.countDocuments({
        type: "appointments",
        status: { $in: ["pending", "confirmed", "in-progress"] },
      }),
      Lead.countDocuments({ type: "appointments", status: "completed" }),
      Content.countDocuments({ kind: "posts" }),
      Lead.countDocuments({ type: "enquiries" }),
    ],
  );
  res.json({ appointments, pending, completed, posts, messages });
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});
app.post("/api/admin/upload", upload.single("image"), async (req, res) => {
  const b = req.file?.buffer;
  let mime;
  if (b?.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
    mime = "image/jpeg";
  else if (
    b?.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    mime = "image/png";
  else if (
    b?.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  )
    mime = "image/webp";
  if (!mime)
    return res
      .status(400)
      .json({ error: "Upload a JPEG, PNG or WebP image up to 5 MB." });
  const asset = await Asset.create({ data: b, mime });
  res.status(201).json({ url: `/api/images/${asset._id}` });
});
app.param("collection", (req, res, next, value) => {
  if (
    ![
      "appointments",
      "enquiries",
      "posts",
      "services",
      "faqs",
      "reviews",
    ].includes(value)
  )
    return res.sendStatus(404);
  req.isLead = ["appointments", "enquiries"].includes(value);
  next();
});
app.get("/api/admin/:collection", async (req, res) => {
  const Model = req.isLead ? Lead : Content;
  if (req.query.page !== undefined) {
    const input = z
      .object({
        page: z.coerce.number().int().min(1).max(1000000),
        q: z.string().trim().max(200).default(""),
        status: z
          .enum([
            "",
            "pending",
            "confirmed",
            "in-progress",
            "completed",
            "cancelled",
          ])
          .default(""),
        notification: z.string().max(40).default(""),
        brand: z.string().max(80).default(""),
        published: z.enum(["", "true", "false"]).default(""),
        sort: z.enum(["newest", "oldest"]).default("newest"),
      })
      .parse(req.query);
    const base = req.isLead
      ? { type: req.params.collection }
      : { kind: req.params.collection };
    const filter = { ...base };
    if (req.isLead) {
      if (input.status) filter.status = input.status;
      if (input.notification) filter.notification = input.notification;
      if (input.brand) filter.brand = input.brand;
    } else if (input.published) filter.published = input.published === "true";
    const fields = req.isLead
      ? [
          "name",
          "email",
          "phone",
          "postcode",
          "brand",
          "problem",
          "preferredDate",
          "status",
          "notification",
        ]
      : [
          "title",
          "slug",
          "description",
          "content",
          "category",
          "label",
          "location",
        ];
    if (input.q)
      filter.$and = input.q.split(/\s+/).map((term) => ({
        $or: fields.map((field) => ({
          [field]: {
            $regex: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            $options: "i",
          },
        })),
      }));
    const [total, brands, notifications] = await Promise.all([
      Model.countDocuments(filter),
      req.isLead ? Model.distinct("brand", base) : [],
      req.isLead ? Model.distinct("notification", base) : [],
    ]);
    const pages = Math.max(1, Math.ceil(total / 10));
    const page = Math.min(input.page, pages);
    const direction = input.sort === "oldest" ? 1 : -1;
    const items = await Model.find(filter)
      .sort({ createdAt: direction, _id: direction })
      .skip((page - 1) * 10)
      .limit(10)
      .lean();
    return res.json({
      items,
      total,
      page,
      pages,
      brands: brands.filter(Boolean).sort(),
      notifications: notifications.filter(Boolean).sort(),
    });
  }
  res.json(
    await Model.find(
      req.isLead
        ? { type: req.params.collection }
        : { kind: req.params.collection },
    )
      .sort({ createdAt: -1 })
      .limit(500)
      .lean(),
  );
});
app.post("/api/admin/:collection", async (req, res) => {
  if (req.isLead) return res.sendStatus(405);
  const data = contentSchema.parse(req.body);
  res
    .status(201)
    .json(await Content.create({ ...data, kind: req.params.collection }));
});
app.patch("/api/admin/:collection/:id", validId, async (req, res) => {
  const Model = req.isLead ? Lead : Content;
  const data = req.isLead
    ? z
        .object({
          name: leadSchema.shape.name.optional(),
          email: leadSchema.shape.email.optional(),
          phone: leadSchema.shape.phone.optional(),
          brand: leadSchema.shape.brand.optional(),
          postcode: z
            .union([z.literal(""), leadSchema.shape.postcode])
            .optional(),
          problem: leadSchema.shape.problem.optional(),
          preferredDate: z
            .string()
            .refine((value) => {
              if (!value) return true;
              if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
              const date = new Date(`${value}T12:00:00Z`);
              return (
                !Number.isNaN(date.getTime()) &&
                date.toISOString().slice(0, 10) === value
              );
            }, "Please select a valid date.")
            .optional(),
          status: z.enum([
            "pending",
            "confirmed",
            "in-progress",
            "completed",
            "cancelled",
          ]),
        })
        .parse(req.body)
    : contentSchema.parse(req.body);
  const updated = await Model.findOneAndUpdate(
    {
      _id: req.params.id,
      ...(req.isLead
        ? { type: req.params.collection }
        : { kind: req.params.collection }),
    },
    { $set: data },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) return res.sendStatus(404);
  res.json(updated);
});
app.post(
  "/api/admin/:collection/:id/retry-email",
  validId,
  async (req, res) => {
    if (!req.isLead) return res.sendStatus(404);
    if (!notificationEmail)
      return res
        .status(503)
        .json({ error: "FormSubmit email is not configured." });
    const lead = await Lead.findOne({
      _id: req.params.id,
      type: req.params.collection,
    });
    if (!lead) return res.sendStatus(404);
    await notifyLead(lead);
    res.json({ notification: lead.notification });
  },
);
app.delete("/api/admin/:collection/:id", validId, async (req, res) => {
  const Model = req.isLead ? Lead : Content;
  const result = await Model.deleteOne({
    _id: req.params.id,
    ...(req.isLead
      ? { type: req.params.collection }
      : { kind: req.params.collection }),
  });
  if (!result.deletedCount) return res.sendStatus(404);
  res.json({ ok: true });
});
app.use((err, req, res, next) => {
  if (err instanceof z.ZodError)
    return res.status(400).json({
      error: err.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    });
  if (err.code === 11000)
    return res
      .status(409)
      .json({ error: "This URL slug already exists. Choose another." });
  if (err instanceof multer.MulterError)
    return res.status(400).json({ error: "Image must be under 5 MB." });
  console.error(err.name || "API error");
  res
    .status(err.status === 400 ? 400 : 500)
    .json({ error: "Unable to process this request. Please try again." });
});
async function start() {
  if (process.env.MONGODB_URI) {
    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
      });
      if (!(await Setting.findById("initial-content"))) {
        for (const item of require("./initial-content.json"))
          await Content.updateOne(
            { kind: item.kind, slug: item.slug },
            { $setOnInsert: item },
            { upsert: true },
          );
        await Setting.updateOne(
          { _id: "initial-content" },
          { $set: { done: true } },
          { upsert: true },
        );
      }
      if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
        if (process.env.ADMIN_PASSWORD.length < 14)
          throw new Error("ADMIN_PASSWORD must be at least 14 characters.");
        const existing = await Admin.findOne({
          email: process.env.ADMIN_EMAIL.toLowerCase(),
        });
        if (!existing)
          await Admin.create({
            email: process.env.ADMIN_EMAIL.toLowerCase(),
            passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12),
          });
      }
    } catch (e) {
      console.error("Database startup failed:", e.message);
    }
  } else
    console.log(
      "MONGODB_URI is not configured. Public website works; persistence requires MongoDB.",
    );
  return app.listen(
    Number(process.env.PORT || 4000),
    process.env.HOST || "127.0.0.1",
    () =>
      console.log(`Pinterok API listening on port ${process.env.PORT || 4000}`),
  );
}
if (require.main === module) start();
module.exports = {
  app,
  start,
  models: { Lead, Content, Admin, Session, Asset },
  mongoose,
};
