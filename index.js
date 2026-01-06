import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import pkg from "pg";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// ===== ENVIRONMENT VARIABLES =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// ===== DATABASE =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== INIT TABLE =====
await pool.query(`
  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    text TEXT NOT NULL,
    sender_name VARCHAR(16),
    sender_ip VARCHAR(45),
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL
  );
`);

// ===== UTILITIES =====
function validName(name) {
  return /^[a-zA-Z0-9 ]{1,16}$/.test(name);
}

async function moderate(text) {
  const res = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "omni-moderation-latest",
      input: text
    })
  });

  const data = await res.json();
  return data.results[0].flagged;
}

// ===== CLEANUP EXPIRED =====
async function cleanupExpired() {
  await pool.query("DELETE FROM messages WHERE expires_at < NOW()");
}

// ===== ROUTES =====

app.get("/", (req, res) => {
  res.send("Aippy Message Board Backend Running");
});

// --- SEND MESSAGE ---
app.post("/messages/send", async (req, res) => {
  try {
    const { text, sender, ip } = req.body;

    if (!text || !ip) {
      return res.status(400).json({ error: "Missing text or IP" });
    }

    if (text.length > 300) {
      return res.status(400).json({ error: "Message too long" });
    }

    const name = sender?.trim() || "Anonymous";

    if (name !== "Anonymous" && !validName(name)) {
      return res.status(400).json({ error: "Invalid username format" });
    }

    // Rate limit (1 msg / minute / IP)
    const recent = await pool.query(
      "SELECT created_at FROM messages WHERE sender_ip = $1 ORDER BY created_at DESC LIMIT 1",
      [ip]
    );

    if (recent.rows.length) {
      const diff = (Date.now() - new Date(recent.rows[0].created_at)) / 1000;
      if (diff < 60) {
        return res.status(429).json({ error: "Cooldown active" });
      }
    }

    // Moderation
    if (await moderate(text) || await moderate(name)) {
      return res.status(400).json({ error: "Message rejected by moderation" });
    }

    const expires = new Date(Date.now() + 10 * 60 * 60 * 1000);

    await pool.query(
      "INSERT INTO messages (text, sender_name, sender_ip, expires_at) VALUES ($1,$2,$3,$4)",
      [text, name, ip, expires]
    );

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// --- LATEST MESSAGES ---
app.get("/messages/latest", async (req, res) => {
  await cleanupExpired();

  const result = await pool.query(`
    SELECT text, sender_name, expires_at
    FROM messages
    WHERE expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 50
  `);

  const now = Date.now();

  res.json(
    result.rows.map(m => ({
      text: m.text,
      sender: m.sender_name,
      expires_in_seconds: Math.max(
        0,
        Math.floor((new Date(m.expires_at) - now) / 1000)
      )
    }))
  );
});

// --- RANDOM MESSAGE ---
app.get("/messages/random", async (req, res) => {
  const { ip } = req.query;
  if (!ip) return res.status(400).json({ error: "IP required" });

  await cleanupExpired();

  const result = await pool.query(`
    SELECT text, sender_name
    FROM messages
    WHERE sender_ip != $1
    ORDER BY RANDOM()
    LIMIT 1
  `, [ip]);

  if (!result.rows.length) {
    return res.json({ message: null });
  }

  res.json({
    text: result.rows[0].text,
    sender: result.rows[0].sender_name
  });
});

// --- ADMIN VIEW ---
app.get("/admin/messages", async (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) {
    return res.status(403).send("Forbidden");
  }

  const result = await pool.query(`
    SELECT id, text, sender_name, sender_ip, created_at, expires_at
    FROM messages
    ORDER BY created_at DESC
  `);

  res.json(result.rows);
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
