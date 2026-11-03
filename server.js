#!/usr/bin/env node
// Local web UI for club-news: node server.js  ->  http://localhost:3000
// Users: first visit creates the admin; admins add/remove other users. Chats are per article.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fetchItems, loadJson, saveJson, CLUBS_FILE } = require("./club-news");

const PORT = Number(process.env.PORT) || 3000;
const INDEX = path.join(__dirname, "index.html");
const USERS_FILE = path.join(__dirname, "users.json");
const CHATS_FILE = path.join(__dirname, "chats.json");
const SESSIONS_FILE = path.join(__dirname, "sessions.json");
const SESSION_MS = 7 * 24 * 3600 * 1000;

const send = (res, code, body, type = "application/json", headers = {}) => {
  res.writeHead(code, { "Content-Type": type, ...headers });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });

// ---- users / sessions ----
const hashPw = (pw, salt = crypto.randomBytes(16).toString("hex")) =>
  ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") });
const checkPw = (pw, u) =>
  crypto.timingSafeEqual(Buffer.from(hashPw(pw, u.salt).hash, "hex"), Buffer.from(u.hash, "hex"));
const users = () => loadJson(USERS_FILE, []);
const publicUser = (u) => ({ username: u.username, role: u.role });

let sessions = loadJson(SESSIONS_FILE, {});
const saveSessions = () => saveJson(SESSIONS_FILE, sessions);
function startSession(res, username) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions[token] = { username, expires: Date.now() + SESSION_MS };
  saveSessions();
  return { "Set-Cookie": `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` };
}
function currentUser(req) {
  const m = (req.headers.cookie || "").match(/(?:^|; )sid=([a-f0-9]+)/);
  const s = m && sessions[m[1]];
  if (!s) return null;
  if (s.expires < Date.now()) { delete sessions[m[1]]; saveSessions(); return null; }
  const u = users().find((x) => x.username === s.username);
  return u ? { ...publicUser(u), token: m[1] } : null;
}
const failures = {}; // username -> {n, until}
const validName = (s) => typeof s === "string" && /^[A-Za-z0-9_.-]{2,32}$/.test(s);
const validPw = (s) => typeof s === "string" && s.length >= 6 && s.length <= 200;

// ---- chats ----
const articleId = (link) => crypto.createHash("sha1").update(link).digest("hex").slice(0, 16);
const chats = () => loadJson(CHATS_FILE, {});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === "/") return send(res, 200, fs.readFileSync(INDEX, "utf8"), "text/html; charset=utf-8");

    // --- auth endpoints (no login needed) ---
    if (p === "/api/me" && req.method === "GET") {
      const user = currentUser(req);
      if (user) return send(res, 200, { user: publicUser(user) });
      return send(res, 401, { setup: users().length === 0 });
    }
    if (p === "/api/setup" && req.method === "POST") {
      if (users().length) return send(res, 403, { error: "already set up" });
      const { username, password } = await readBody(req);
      if (!validName(username) || !validPw(password))
        return send(res, 400, { error: "Username 2-32 chars (letters, digits, _ . -), password at least 6 chars" });
      saveJson(USERS_FILE, [{ username, role: "admin", ...hashPw(password) }]);
      return send(res, 200, { user: { username, role: "admin" } }, "application/json", startSession(res, username));
    }
    if (p === "/api/login" && req.method === "POST") {
      const { username, password } = await readBody(req);
      const f = failures[username] || { n: 0, until: 0 };
      if (f.until > Date.now()) return send(res, 429, { error: "Too many attempts, try again in a minute" });
      const u = users().find((x) => x.username === username);
      if (!u || typeof password !== "string" || !checkPw(password, u)) {
        f.n++;
        if (f.n >= 5) { f.n = 0; f.until = Date.now() + 60000; }
        failures[username] = f;
        return send(res, 401, { error: "Wrong username or password" });
      }
      delete failures[username];
      return send(res, 200, { user: publicUser(u) }, "application/json", startSession(res, u.username));
    }

    // --- everything below needs a login ---
    const me = currentUser(req);
    if (!me) return send(res, 401, { error: "login required" });
    const isAdmin = me.role === "admin";

    if (p === "/api/logout" && req.method === "POST") {
      delete sessions[me.token]; saveSessions();
      return send(res, 200, {}, "application/json", { "Set-Cookie": "sid=; HttpOnly; Path=/; Max-Age=0" });
    }

    // --- user management (admin) ---
    if (p === "/api/users") {
      if (!isAdmin) return send(res, 403, { error: "admin only" });
      if (req.method === "GET") return send(res, 200, users().map(publicUser));
      if (req.method === "POST") {
        const { username, password, role } = await readBody(req);
        if (!validName(username) || !validPw(password))
          return send(res, 400, { error: "Username 2-32 chars (letters, digits, _ . -), password at least 6 chars" });
        const list = users();
        if (list.some((u) => u.username.toLowerCase() === username.toLowerCase()))
          return send(res, 409, { error: "user exists" });
        list.push({ username, role: role === "admin" ? "admin" : "member", ...hashPw(password) });
        saveJson(USERS_FILE, list);
        return send(res, 201, list.map(publicUser));
      }
      if (req.method === "DELETE") {
        const name = url.searchParams.get("username");
        if (name === me.username) return send(res, 400, { error: "You can't remove yourself" });
        const list = users().filter((u) => u.username !== name);
        saveJson(USERS_FILE, list);
        for (const [t, s] of Object.entries(sessions)) if (s.username === name) delete sessions[t];
        saveSessions();
        return send(res, 200, list.map(publicUser));
      }
    }

    // --- clubs ---
    if (p === "/api/clubs" && req.method === "GET") return send(res, 200, loadJson(CLUBS_FILE, []));
    if (p === "/api/clubs" && ["POST", "DELETE"].includes(req.method) && !isAdmin)
      return send(res, 403, { error: "admin only" });
    if (p === "/api/clubs" && req.method === "POST") {
      const { name, sport } = await readBody(req);
      if (!name || !name.trim()) return send(res, 400, { error: "name required" });
      const clubs = loadJson(CLUBS_FILE, []);
      if (clubs.some((c) => c.name.toLowerCase() === name.trim().toLowerCase()))
        return send(res, 409, { error: "already exists" });
      clubs.push({ name: name.trim(), sport: (sport || "Other").trim() || "Other", query: name.trim() });
      saveJson(CLUBS_FILE, clubs);
      return send(res, 201, clubs);
    }
    if (p === "/api/clubs" && req.method === "DELETE") {
      const name = url.searchParams.get("name");
      const clubs = loadJson(CLUBS_FILE, []).filter((c) => c.name !== name);
      saveJson(CLUBS_FILE, clubs);
      return send(res, 200, clubs);
    }

    // --- news (items carry an id and chat count) ---
    if (p === "/api/news" && req.method === "GET") {
      const days = Number(url.searchParams.get("days")) || 2;
      const limit = Number(url.searchParams.get("limit")) || 8;
      const lang = url.searchParams.get("lang") || "en";
      const all = chats();
      const out = await Promise.all(
        loadJson(CLUBS_FILE, []).map(async (club) => {
          try {
            const items = (await fetchItems(club, days, lang)).slice(0, limit).map((i) => {
              const id = articleId(i.link);
              return { ...i, id, chats: (all[id] || []).length };
            });
            return { ...club, items };
          } catch (e) {
            return { ...club, items: [], error: e.message };
          }
        })
      );
      return send(res, 200, out);
    }

    // --- article chat ---
    if (p === "/api/chat") {
      const id = url.searchParams.get("id") || "";
      if (!/^[a-f0-9]{16}$/.test(id)) return send(res, 400, { error: "bad id" });
      const all = chats();
      if (req.method === "GET") return send(res, 200, all[id] || []);
      if (req.method === "POST") {
        const { text } = await readBody(req);
        const t = typeof text === "string" ? text.trim().slice(0, 1000) : "";
        if (!t) return send(res, 400, { error: "empty message" });
        (all[id] = all[id] || []).push({
          id: crypto.randomBytes(6).toString("hex"), user: me.username, text: t, at: new Date().toISOString(),
        });
        saveJson(CHATS_FILE, all);
        return send(res, 201, all[id]);
      }
      if (req.method === "DELETE") {
        const mid = url.searchParams.get("mid");
        const msg = (all[id] || []).find((m) => m.id === mid);
        if (!msg) return send(res, 404, { error: "not found" });
        if (msg.user !== me.username && !isAdmin) return send(res, 403, { error: "not allowed" });
        all[id] = all[id].filter((m) => m.id !== mid);
        saveJson(CHATS_FILE, all);
        return send(res, 200, all[id]);
      }
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`Club news UI: http://localhost:${PORT}`));
