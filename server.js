import express from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";
const ROBLOX_USERNAME = process.env.ROBLOX_USERNAME || "psk062";
const db = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null;
const orderRate = new Map();

function orderAllowed(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  const now = Date.now();
  const recent = orderRate.get(ip) || [];
  const kept = recent.filter(t => now - t < 60 * 60 * 1000);
  if (kept.length >= 8) return false;
  kept.push(now);
  orderRate.set(ip, kept);
  if (orderRate.size > 5000) {
    for (const [k, arr] of orderRate) if (!arr.some(t => now - t < 60 * 60 * 1000)) orderRate.delete(k);
  }
  return true;
}

const clamp = (n, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : min));
const clean = (value, max = 2000) => String(value ?? "").trim().slice(0, max);
const tokenHash = (token) => crypto.createHash("sha256").update(token).digest("hex");
const makeToken = () => crypto.randomBytes(24).toString("hex");
async function logEvent(orderId,eventType,actor="system",details=""){
  if(!db||!orderId)return;
  try{await db.from("order_events").insert([{order_id:orderId,event_type:eventType,actor,details:clean(details,700)}])}catch{}
}
async function logEvent(orderId,eventType,actor="system",details=""){
  if(!db||!orderId)return;
  try{await db.from("order_events").insert([{order_id:orderId,event_type:eventType,actor,details:clean(details,700)}])}catch{}
}

function auth(req, res, next) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!ADMIN_PASSWORD || token !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function fallbackEstimate(body) {
  const type = clean(body.project_type, 60).toLowerCase();
  const featureCount = Array.isArray(body.features) ? body.features.length : 0;
  const desc = clean(body.description, 2500);
  let min = 3000, max = 7000;
  if (type.includes("roblox")) [min, max] = [5000, 12000];
  else if (type.includes("discord")) [min, max] = [3000, 8000];
  else if (type.includes("minecraft")) [min, max] = [4000, 9000];
  else if (type.includes("custom")) [min, max] = [6000, 15000];
  else if (type.includes("website")) [min, max] = [3500, 9000];
  const complexity = clamp(35 + featureCount * 7 + Math.round(desc.length / 240), 20, 95);
  const boost = Math.round(complexity / 20) * 500;
  min += boost;
  max += boost;
  return {
    complexity,
    min_robux: Math.round(min / 100) * 100,
    max_robux: Math.round(max / 100) * 100,
    timeline: complexity > 75 ? "10–21 days" : complexity > 50 ? "7–14 days" : "3–10 days",
    reason: "Initial scope-based estimate. Final reward is confirmed by Kylo after reviewing the request."
  };
}

async function aiEstimate(body) {
  if (!OPENROUTER_API_KEY) return fallbackEstimate(body);
  const payload = {
    model: OPENROUTER_MODEL,
    temperature: 0.25,
    max_tokens: 500,
    messages: [
      {
        role: "system",
        content: "You estimate software project scope for a developer portfolio. The client reward is measured only in Robux. Return ONLY valid JSON with keys: complexity (integer 0-100), min_robux (integer), max_robux (integer), timeline (short string), reason (short string). Do not mention dollars. Keep estimates practical for a solo developer."
      },
      {
        role: "user",
        content: JSON.stringify({
          type: clean(body.project_type, 80),
          title: clean(body.title, 140),
          description: clean(body.description, 3000),
          features: Array.isArray(body.features) ? body.features.slice(0, 20).map(x => clean(x, 120)) : [],
          links: Array.isArray(body.links) ? body.links.slice(0, 5).map(x => clean(x, 300)) : []
        })
      }
    ]
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + OPENROUTER_API_KEY,
        "HTTP-Referer": process.env.SITE_URL || "https://kylo.is-a.dev",
        "X-Title": "Kylo Portfolio"
      },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error("OpenRouter request failed: " + r.status);
    const data = await r.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    const min = Math.round(clamp(parsed.min_robux, 500, 100000) / 100) * 100;
    const max = Math.round(clamp(parsed.max_robux, min, 120000) / 100) * 100;
    return {
      complexity: Math.round(clamp(parsed.complexity, 1, 100)),
      min_robux: min,
      max_robux: Math.max(min, max),
      timeline: clean(parsed.timeline, 80) || "7–14 days",
      reason: clean(parsed.reason, 420) || "Initial AI scope estimate."
    };
  } catch {
    return fallbackEstimate(body);
  } finally {
    clearTimeout(timeout);
  }
}

app.get("/api/projects", async (_req, res) => {
  if (!db) return res.json([]);
  const { data, error } = await db.from("projects").select("*").order("featured", { ascending: false }).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post("/api/projects", auth, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Supabase is not configured" });
  const body = req.body || {};
  const record = {
    title: clean(body.title, 140),
    description: clean(body.description, 2500),
    category: clean(body.category, 50) || "Other",
    image: clean(body.image, 700),
    demo_url: clean(body.demo_url, 700),
    github_url: clean(body.github_url, 700),
    technologies: Array.isArray(body.technologies) ? body.technologies.slice(0, 15).map(x => clean(x, 60)).filter(Boolean) : [],
    status: clean(body.status, 30) || "Live",
    featured: Boolean(body.featured)
  };
  const { data, error } = await db.from("projects").insert([record]).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.put("/api/projects/:id", auth, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Supabase is not configured" });
  const body = req.body || {};
  const record = {
    title: clean(body.title, 140),
    description: clean(body.description, 2500),
    category: clean(body.category, 50) || "Other",
    image: clean(body.image, 700),
    demo_url: clean(body.demo_url, 700),
    github_url: clean(body.github_url, 700),
    technologies: Array.isArray(body.technologies) ? body.technologies.slice(0, 15).map(x => clean(x, 60)).filter(Boolean) : [],
    status: clean(body.status, 30) || "Live",
    featured: Boolean(body.featured)
  };
  const { data, error } = await db.from("projects").update(record).eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete("/api/projects/:id", auth, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Supabase is not configured" });
  const { error } = await db.from("projects").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

app.post("/api/orders", async (req, res) => {
  if (!orderAllowed(req)) return res.status(429).json({ error: "Too many requests. Please try again later." });
  if (!db) return res.status(500).json({ error: "Database is not configured" });
  const b = req.body || {};
  const required = ["client_name", "contact", "project_type", "title", "description"];
  if (required.some(k => !clean(b[k]))) return res.status(400).json({ error: "Please complete the required fields." });

  const estimate = await aiEstimate(b);
  const token = makeToken();
  const record = {
    client_name: clean(b.client_name, 100),
    contact: clean(b.contact, 160),
    roblox_username: clean(b.roblox_username, 80),
    project_type: clean(b.project_type, 80),
    title: clean(b.title, 160),
    description: clean(b.description, 3500),
    features: Array.isArray(b.features) ? b.features.slice(0, 20).map(x => clean(x, 120)).filter(Boolean) : [],
    links: Array.isArray(b.links) ? b.links.slice(0, 5).map(x => clean(x, 350)).filter(Boolean) : [],
    ai_complexity: estimate.complexity,
    ai_min_robux: estimate.min_robux,
    ai_max_robux: estimate.max_robux,
    ai_timeline: estimate.timeline,
    ai_reason: estimate.reason,
    final_robux: null,
    status: "REQUESTED",
    payment_status: "PENDING",
    client_token_hash: tokenHash(token)
  };

  const { data, error } = await db.from("orders").insert([record]).select("id,client_name,contact,roblox_username,project_type,title,description,features,links,ai_complexity,ai_min_robux,ai_max_robux,ai_timeline,ai_reason,final_robux,status,payment_status,created_at,updated_at").single();
  if (error) return res.status(400).json({ error: error.message });

  await db.from("messages").insert([{
    order_id: data.id,
    sender: "admin",
    content: "Thanks for the request! I’ve received your project details and will review the scope here."
  }]);
  await logEvent(data.id,"REQUEST_CREATED","system","New project request received");

  res.status(201).json({ order: data, client_token: token, roblox_username: ROBLOX_USERNAME });
});

async function getOrderByToken(token) {
  if (!db || !token) return null;
  const { data, error } = await db.from("orders")
    .select("id,client_name,contact,roblox_username,project_type,title,description,features,links,ai_complexity,ai_min_robux,ai_max_robux,ai_timeline,ai_reason,final_robux,status,payment_status,created_at,updated_at")
    .eq("client_token_hash", tokenHash(token))
    .maybeSingle();
  if (error || !data) return null;
  const msgs = await db.from("messages").select("id,sender,content,created_at").eq("order_id", data.id).order("created_at", { ascending: true });
  const events = await db.from("order_events").select("id,event_type,actor,details,created_at").eq("order_id", data.id).order("created_at", { ascending: true });
  return { ...data, messages: msgs.data || [], events: events.data || [] };
}

app.get("/api/orders/:token", async (req, res) => {
  const order = await getOrderByToken(clean(req.params.token, 100));
  if (!order) return res.status(404).json({ error: "Project request not found." });
  res.json(order);
});

app.post("/api/orders/:token/messages", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Database is not configured" });
  const order = await getOrderByToken(clean(req.params.token, 100));
  if (!order) return res.status(404).json({ error: "Project request not found." });
  const content = clean(req.body?.content, 1600);
  if (!content) return res.status(400).json({ error: "Message is empty." });
  const { data, error } = await db.from("messages").insert([{ order_id: order.id, sender: "client", content }]).select("id,sender,content,created_at").single();
  if (error) return res.status(400).json({ error: error.message });
  await logEvent(order.id,"CLIENT_MESSAGE","client",content);
  res.status(201).json(data);
});

app.get("/api/admin/system", auth, (_req, res) => {
  res.json({
    ai_enabled: Boolean(OPENROUTER_API_KEY),
    ai_model: OPENROUTER_MODEL,
    reward_username: ROBLOX_USERNAME,
    database_connected: Boolean(db)
  });
});

app.get("/api/admin/orders", auth, async (_req, res) => {
  if (!db) return res.json([]);
  const { data, error } = await db.from("orders").select("id,client_name,contact,roblox_username,project_type,title,ai_min_robux,ai_max_robux,ai_complexity,ai_timeline,final_robux,status,payment_status,created_at,updated_at").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get("/api/admin/orders/:id", auth, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Database is not configured" });
  const { data, error } = await db.from("orders").select("*").eq("id", req.params.id).single();
  if (error) return res.status(404).json({ error: "Project request not found." });
  const msgs = await db.from("messages").select("id,sender,content,created_at").eq("order_id", req.params.id).order("created_at", { ascending: true });
  const events = await db.from("order_events").select("id,event_type,actor,details,created_at").eq("order_id", req.params.id).order("created_at", { ascending: true });
  res.json({ ...data, messages: msgs.data || [], events: events.data || [] });
});

app.post("/api/admin/orders/:id/messages", auth, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Database is not configured" });
  const content = clean(req.body?.content, 1600);
  if (!content) return res.status(400).json({ error: "Message is empty." });
  const { data, error } = await db.from("messages").insert([{ order_id: req.params.id, sender: "admin", content }]).select("id,sender,content,created_at").single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

app.get("/api/admin/orders/:id/events", auth, async (req,res)=>{
  if(!db)return res.status(500).json({error:"Database is not configured"});
  const {data,error}=await db.from("order_events").select("id,event_type,actor,details,created_at").eq("order_id",req.params.id).order("created_at",{ascending:true});
  if(error)return res.status(400).json({error:error.message});
  res.json(data||[]);
});

app.patch("/api/admin/orders/:id", auth, async (req, res) => {
  if (!db) return res.status(500).json({ error: "Database is not configured" });
  const allowedStatus = ["REQUESTED","REVIEWING","ACCEPTED","IN_PROGRESS","PAYMENT_PENDING","PAID","COMPLETED","REJECTED","CLOSED"];
  const allowedPayment = ["PENDING","PAID"];
  const patch = {};
  const requestedStatus = req.body.status && allowedStatus.includes(req.body.status) ? req.body.status : null;
  if (requestedStatus) patch.status = requestedStatus;
  if (req.body.payment_status && allowedPayment.includes(req.body.payment_status)) patch.payment_status = req.body.payment_status;
  if (req.body.final_robux !== undefined && req.body.final_robux !== null && req.body.final_robux !== "") {
    patch.final_robux = Math.round(clamp(req.body.final_robux, 100, 1000000));
  }
  patch.updated_at = new Date().toISOString();
  const { data, error } = await db.from("orders").update(patch).eq("id", req.params.id).select("*").single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.get("/health", (_req,res)=>res.json({ok:true,service:"kylo"}));\n\napp.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/project/:token", (_req, res) => res.sendFile(path.join(__dirname, "public", "project.html")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/")) return res.sendFile(path.join(__dirname, "index.html"));
  next();
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Kylo running on " + port));
