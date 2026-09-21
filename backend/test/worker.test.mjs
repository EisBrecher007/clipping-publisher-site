import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

class MemoryKV {
  values = new Map();
  async get(key) { return this.values.get(key) ?? null; }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

const env = () => ({
  APP_ORIGIN: "https://eisbrecher007.github.io",
  API_ORIGIN: "https://worker.example",
  TIKTOK_CLIENT_KEY: "test-client-key",
  TIKTOK_CLIENT_SECRET: "test-client-secret",
  TOKEN_ENCRYPTION_KEY_BASE64: Buffer.from("01234567890123456789012345678901").toString("base64"),
  TOKENS: new MemoryKV(),
});

function response(body) { return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }); }

async function connectedSession(e) {
  const start = await worker.fetch(new Request("https://worker.example/oauth/start"), e);
  const auth = new URL(start.headers.get("location"));
  const state = auth.searchParams.get("state");
  const cookie = start.headers.get("set-cookie").split(";")[0];
  const callback = await worker.fetch(new Request(`https://worker.example/oauth/callback?code=single-use-code&state=${state}`, { headers: { cookie } }), e);
  assert.equal(callback.status, 302);
  return new URL(callback.headers.get("location")).hash.slice("#session=".length);
}

test("expired token refreshes automatically before live creator preflight and stays encrypted", async () => {
  const e = env();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push(String(url));
    if (String(url).includes("oauth/token")) {
      const grant = options.body.get("grant_type");
      return response(grant === "authorization_code"
        ? { access_token: "initial-access", refresh_token: "initial-refresh", expires_in: 0, refresh_expires_in: 3600, scope: "video.publish" }
        : { access_token: "refreshed-access", refresh_token: "refreshed-refresh", expires_in: 3600, refresh_expires_in: 3600, scope: "video.publish" });
    }
    if (String(url).includes("creator_info/query")) {
      assert.match(options.headers.Authorization, /^Bearer refreshed-access$/);
      return response({ error: { code: "ok" }, data: { creator_username: "sandbox", privacy_level_options: ["SELF_ONLY"], max_video_post_duration_sec: 300 } });
    }
    throw new Error(`unexpected network request: ${url}`);
  };
  try {
    const sid = await connectedSession(e);
    const res = await worker.fetch(new Request("https://worker.example/api/creator-info", { method: "POST", headers: { Authorization: `Bearer ${sid}` } }), e);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.creator.creator_username, "sandbox");
    assert.equal(calls.filter(value => value.includes("oauth/token")).length, 2);
    const encrypted = await e.TOKENS.get(`session:${sid}`);
    assert.ok(encrypted && !encrypted.includes("refreshed-access") && !encrypted.includes("refreshed-refresh"));
  } finally { globalThis.fetch = originalFetch; }
});

test("prepare persists one publish identity and duplicate prepare never reinitializes", async () => {
  const e = env();
  const originalFetch = globalThis.fetch;
  let initCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("oauth/token")) return response(options.body.get("grant_type") === "refresh_token" ? { access_token: "access-refreshed", refresh_token: "refresh-refreshed", expires_in: 3600, refresh_expires_in: 3600 } : { access_token: "access", refresh_token: "refresh", expires_in: 3600, refresh_expires_in: 3600, scope: "video.publish" });
    if (String(url).includes("creator_info/query")) return response({ error: { code: "ok" }, data: { privacy_level_options: ["SELF_ONLY"], max_video_post_duration_sec: 300 } });
    if (String(url).includes("video/init")) { initCalls++; return response({ error: { code: "ok" }, data: { publish_id: "opaque-publish-id", upload_url: "https://upload.example/one" } }); }
    throw new Error(`unexpected network request: ${url}`);
  };
  try {
    const sid = await connectedSession(e);
    const makeRequest = () => { const form = new FormData(); form.set("video", new File(["neutral"], "video.mp4", { type: "video/mp4" })); form.set("privacy_level", "SELF_ONLY"); form.set("duration_seconds", "1"); form.set("title", "neutral"); return new Request("https://worker.example/api/direct-post/prepare", { method: "POST", headers: { Authorization: `Bearer ${sid}` }, body: form }); };
    const first = await worker.fetch(makeRequest(), e);
    const second = await worker.fetch(makeRequest(), e);
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    assert.equal(initCalls, 1);
    const persisted = [...e.TOKENS.values.values()].find(value => value.includes("opaque-publish-id"));
    assert.equal(persisted, undefined, "publish identity must be encrypted at rest");
  } finally { globalThis.fetch = originalFetch; }
});

test("fresh SELF_ONLY status completion requires visibility verification", async () => {
  const e = env();
  const originalFetch = globalThis.fetch;
  let initCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("oauth/token")) return response({ access_token: "access", refresh_token: "refresh", expires_in: 3600, refresh_expires_in: 3600, scope: "video.publish" });
    if (target.includes("creator_info/query")) return response({ error: { code: "ok" }, data: { privacy_level_options: ["SELF_ONLY"], max_video_post_duration_sec: 300 } });
    if (target.includes("video/init")) { initCalls++; return response({ error: { code: "ok" }, data: { publish_id: "opaque-publish-id", upload_url: "https://upload.example/one" } }); }
    if (target === "https://upload.example/one") return new Response(null, { status: 200 });
    if (target.includes("status/fetch")) return response({ error: { code: "ok" }, data: { status: "PUBLISH_COMPLETE", uploaded_bytes: 7 } });
    throw new Error(`unexpected network request: ${url}`);
  };
  try {
    const sid = await connectedSession(e);
    const requestFor = (path, confirmed = false) => { const form = new FormData(); form.set("video", new File(["neutral"], "video.mp4", { type: "video/mp4" })); form.set("privacy_level", "SELF_ONLY"); form.set("duration_seconds", "1"); form.set("title", "neutral"); if (confirmed) form.set("confirmed", "true"); return new Request(`https://worker.example${path}`, { method: "POST", headers: { Authorization: `Bearer ${sid}` }, body: form }); };
    await worker.fetch(requestFor("/api/direct-post/prepare"), e);
    const upload = await worker.fetch(requestFor("/api/direct-post/upload", true), e);
    const body = await upload.json();
    assert.equal(upload.status, 200);
    assert.equal(body.status, "PUBLISH_COMPLETE");
    assert.equal(body.visibility_verification_required, true);
    assert.equal(initCalls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("one-time Windows pairing can use the encrypted machine credential after browser OAuth", async () => {
  const e = env(); const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("oauth/token")) return response({ access_token: "access", refresh_token: "refresh", expires_in: 3600, refresh_expires_in: 3600, scope: "video.publish" });
    if (String(url).includes("creator_info/query")) return response({ error: { code: "ok" }, data: { creator_username: "paired-sandbox", privacy_level_options: ["SELF_ONLY"] } });
    throw new Error(`unexpected network request: ${url}`);
  };
  try {
    const machine = "a".repeat(32); const secret = "machine-secret"; const secret_hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)).then(bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join(""));
    const start = await worker.fetch(new Request("https://worker.example/api/scheduler/pair/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ machine_id: machine, secret_hash }) }), e);
    const { pairing_code } = await start.json();
    const sid = await connectedSession(e);
    const complete = await worker.fetch(new Request("https://worker.example/api/scheduler/pair/complete", { method: "POST", headers: { Authorization: `Bearer ${sid}`, "content-type": "application/json" }, body: JSON.stringify({ pairing_code }) }), e);
    assert.equal((await complete.json()).paired, true);
    const creator = await worker.fetch(new Request("https://worker.example/api/creator-info", { method: "POST", headers: { "X-Clipping-Machine": machine, "X-Clipping-Machine-Secret": secret } }), e);
    assert.equal((await creator.json()).creator.creator_username, "paired-sandbox");
    const refresh = await worker.fetch(new Request("https://worker.example/api/token-refresh-check", { method: "POST", headers: { "X-Clipping-Machine": machine, "X-Clipping-Machine-Secret": secret } }), e);
    const refreshBody = await refresh.json();
    assert.equal(refreshBody.refreshed, true);
    assert.equal(refreshBody.scopes, "video.publish");
    const stored = await e.TOKENS.get(`machine:${machine}`);
    assert.ok(stored && !stored.includes(secret) && !stored.includes(sid));
  } finally { globalThis.fetch = originalFetch; }
});
