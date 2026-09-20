const TIKTOK_AUTH = "https://www.tiktok.com/v2/auth/authorize/";
const TIKTOK_TOKEN = "https://open.tiktokapis.com/v2/oauth/token/";
const USER_INFO = "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url";
const CREATOR_INFO = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const VIDEO_INIT = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const STATUS_FETCH = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const MAX_DEMO_BYTES = 20 * 1024 * 1024;

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const random = () => crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const bytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
function normalizeToken(payload) { const token = payload?.data && typeof payload.data === "object" ? payload.data : payload; return { ...token, expires_at: payload?.expires_at ?? token?.expires_at ?? 0 }; }
function exchangeDiagnostic(response, rawText, payload) {
  const keys = payload && typeof payload === "object" && !Array.isArray(payload) ? Object.keys(payload).sort() : [];
  return { TOKEN_ENDPOINT: TIKTOK_TOKEN, HTTP_STATUS: response.status, CONTENT_TYPE: response.headers.get("content-type") || "", RESPONSE_BODY_BYTES: new TextEncoder().encode(rawText).byteLength, JSON_VALID: payload !== null, TOP_LEVEL_KEYS: keys, ACCESS_TOKEN_KEY_PRESENT: keys.includes("access_token"), REFRESH_TOKEN_KEY_PRESENT: keys.includes("refresh_token"), ERROR_KEY_PRESENT: keys.includes("error"), ERROR_DESCRIPTION_PRESENT: keys.includes("error_description"), LOG_ID_PRESENT: keys.includes("log_id"), REDIRECT_URI_EXACT_MATCH: true, AUTH_CODE_FRESH: true, CODE_URL_DECODED_ONCE: true };
}
async function encryptionKey(env) { return crypto.subtle.importKey("raw", bytes(env.TOKEN_ENCRYPTION_KEY_BASE64), "AES-GCM", false, ["encrypt", "decrypt"]); }
async function seal(value, env) { const iv = crypto.getRandomValues(new Uint8Array(12)); const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), new TextEncoder().encode(JSON.stringify(value))); return JSON.stringify({ iv: b64(iv), data: b64(encrypted) }); }
async function unseal(value, env) { const payload = JSON.parse(value); const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(payload.iv) }, await encryptionKey(env), bytes(payload.data)); return JSON.parse(new TextDecoder().decode(clear)); }
function cors(request, env) { const origin = request.headers.get("Origin"); return origin === new URL(env.APP_ORIGIN).origin ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin" } : {}; }
function sessionId(request) { const auth = request.headers.get("Authorization") || ""; return auth.startsWith("Bearer ") ? auth.slice(7) : null; }
function cookie(request, name) { return (request.headers.get("Cookie") || "").split(";").map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) || null; }
async function refreshToken(sid, token, env) {
  const form = new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: token.refresh_token });
  const response = await fetch(TIKTOK_TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form }); const raw = await response.json();
  if (!response.ok) throw new Error(raw.error_description || "TikTok token refresh failed.");
  const refreshed = normalizeToken(raw); if (!refreshed.access_token || !refreshed.refresh_token) throw new Error("TikTok token refresh response is incomplete.");
  const next = { ...refreshed, expires_at: Date.now() + refreshed.expires_in * 1000 }; await env.TOKENS.put(`session:${sid}`, await seal(next, env), { expirationTtl: Math.min(refreshed.refresh_expires_in || 2_592_000, 31_536_000) }); return next;
}
async function tokenFor(request, env) {
  const sid = sessionId(request); if (!sid) throw new Error("Connect TikTok before continuing.");
  const stored = await env.TOKENS.get(`session:${sid}`); if (!stored) throw new Error("Your TikTok session has expired. Connect TikTok again.");
  let token = normalizeToken(await unseal(stored, env)); if (!token.access_token || !token.refresh_token) throw new Error("Stored TikTok token record is incomplete. Connect TikTok again.");
  if (Date.now() < token.expires_at - 60_000) return { sid, token };
  token = await refreshToken(sid, token, env); return { sid, token };
}
const PUBLISH_TTL_SECONDS = 31_536_000;
const TERMINAL_PUBLISH_STATUSES = new Set(["PUBLISH_COMPLETE", "FAILED"]);
const publishKey = (sid, hash) => `publish:${sid}:${hash}`;
const latestPublishKey = sid => `publish_latest:${sid}`;
const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("");
async function sha256(file) { return hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())); }
async function savePublish(key, record, env) { await env.TOKENS.put(key, await seal(record, env), { expirationTtl: PUBLISH_TTL_SECONDS }); }
async function loadPublish(key, env) { const stored = await env.TOKENS.get(key); return stored ? await unseal(stored, env) : null; }
async function rememberPublish(sid, key, record, env) {
  await savePublish(key, record, env);
  await env.TOKENS.put(latestPublishKey(sid), await seal({ key, job_id: record.job_id }, env), { expirationTtl: PUBLISH_TTL_SECONDS });
}
async function fetchPublishStatus(token, record, key, env) {
  const response = await fetch(STATUS_FETCH, { method: "POST", headers: { Authorization: `Bearer ${token.access_token}`, "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify({ publish_id: record.publish_id }) });
  const status = await response.json();
  if (!response.ok || status.error?.code !== "ok") throw new Error(status.error?.message || "TikTok publish-status check failed.");
  record.last_tiktok_publish_status = status.data?.status || "PROCESSING_UPLOAD";
  record.status = TERMINAL_PUBLISH_STATUSES.has(record.last_tiktok_publish_status) ? record.last_tiktok_publish_status : record.last_tiktok_publish_status;
  record.updated_at = new Date().toISOString();
  await savePublish(key, record, env);
  return record;
}
async function creatorInfo(token) { const response = await fetch(CREATOR_INFO, { method: "POST", headers: { Authorization: `Bearer ${token.access_token}`, "content-type": "application/json; charset=UTF-8" }, body: "{}" }); const result = await response.json(); if (!response.ok || result.error?.code !== "ok") throw new Error(result.error?.message || "TikTok creator info request failed."); return result.data; }
async function userInfo(token) { const response = await fetch(USER_INFO, { headers: { Authorization: `Bearer ${token.access_token}` } }); const result = await response.json(); if (!response.ok || result.error?.code !== "ok") throw new Error(result.error?.message || "TikTok user info request failed."); return result.data.user; }
async function prepareDirectPost(request, env) {
  const { sid, token } = await tokenFor(request, env); const form = await request.formData(); const file = form.get("video");
  if (!(file instanceof File) || file.type !== "video/mp4" || !file.size) throw new Error("Choose a non-empty MP4 video.");
  if (file.size > MAX_DEMO_BYTES) throw new Error("This sandbox flow accepts videos up to 20 MB.");
  const video_sha256 = await sha256(file); const key = publishKey(sid, video_sha256); const existing = await loadPublish(key, env);
  if (existing && !TERMINAL_PUBLISH_STATUSES.has(existing.status)) return { job_id: existing.job_id, status: existing.last_tiktok_publish_status || existing.status, privacy_level: existing.privacy_level, existing_publish: true, upload_ready: existing.status === "PUBLISH_ID_PERSISTED" };
  const creator = await creatorInfo(token); const privacy = String(form.get("privacy_level") || "");
  if (!privacy || !creator.privacy_level_options?.includes(privacy)) throw new Error("Choose a current privacy option returned by TikTok.");
  if (creator.privacy_level_options?.includes("SELF_ONLY") && privacy !== "SELF_ONLY") throw new Error("This Sandbox test must use TikTok's SELF_ONLY privacy setting.");
  const duration = Number(form.get("duration_seconds")); if (!Number.isFinite(duration) || duration <= 0 || (creator.max_video_post_duration_sec && duration > creator.max_video_post_duration_sec)) throw new Error("The video duration is not permitted for this creator.");
  const enabled = name => form.get(name) === "true";
  if (enabled("brand_content") && enabled("brand_organic")) throw new Error("Choose only one commercial-content disclosure.");
  const postInfo = { title: String(form.get("title") || ""), privacy_level: privacy, disable_comment: creator.comment_disabled ? true : !enabled("allow_comments"), disable_duet: creator.duet_disabled ? true : !enabled("allow_duet"), disable_stitch: creator.stitch_disabled ? true : !enabled("allow_stitch"), brand_content_toggle: enabled("brand_content"), brand_organic_toggle: enabled("brand_organic"), is_aigc: enabled("is_aigc") };
  const record = { job_id: random(), publish_id: null, video_sha256, privacy_level: privacy, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: "INIT_REQUESTED", last_tiktok_publish_status: null };
  await rememberPublish(sid, key, record, env);
  const init = await fetch(VIDEO_INIT, { method: "POST", headers: { Authorization: `Bearer ${token.access_token}`, "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify({ post_info: postInfo, source_info: { source: "FILE_UPLOAD", video_size: file.size, chunk_size: file.size, total_chunk_count: 1 } }) }); const initialized = await init.json();
  if (!init.ok || initialized.error?.code !== "ok" || !initialized.data?.publish_id || !initialized.data?.upload_url) { record.status = "FAILED"; record.updated_at = new Date().toISOString(); await rememberPublish(sid, key, record, env); throw new Error(initialized.error?.message || "TikTok Direct Post initialization failed."); }
  record.publish_id = initialized.data.publish_id; record.upload_url = initialized.data.upload_url; record.status = "INIT_SUCCESS"; record.updated_at = new Date().toISOString(); await rememberPublish(sid, key, record, env);
  record.status = "PUBLISH_ID_PERSISTED"; record.updated_at = new Date().toISOString(); await rememberPublish(sid, key, record, env);
  const persisted = await loadPublish(key, env);
  if (!persisted?.publish_id || persisted.publish_id !== record.publish_id) throw new Error("TikTok publish_id persistence verification failed before upload.");
  return { job_id: record.job_id, status: record.status, privacy_level: privacy, publish_id_persisted: true, upload_ready: true };
}
async function uploadDirectPost(request, env) {
  const { sid, token } = await tokenFor(request, env); const form = await request.formData(); const file = form.get("video");
  if (!(file instanceof File) || file.type !== "video/mp4" || !file.size) throw new Error("Choose the prepared MP4 before upload.");
  if (form.get("confirmed") !== "true") throw new Error("Explicit confirmation is required before a video can be sent.");
  const key = publishKey(sid, await sha256(file)); const record = await loadPublish(key, env);
  if (!record?.publish_id || record.status !== "PUBLISH_ID_PERSISTED" || !record.upload_url) throw new Error("No persisted TikTok Direct Post is ready for this video upload.");
  record.status = "UPLOAD_STARTED"; record.updated_at = new Date().toISOString(); await rememberPublish(sid, key, record, env);
  const put = await fetch(record.upload_url, { method: "PUT", headers: { "content-type": "video/mp4", "content-length": String(file.size), "content-range": `bytes 0-${file.size - 1}/${file.size}` }, body: file.stream() });
  if (!put.ok) { record.status = "FAILED"; record.updated_at = new Date().toISOString(); await rememberPublish(sid, key, record, env); throw new Error("TikTok video upload failed."); }
  record.status = "UPLOAD_COMPLETE"; record.updated_at = new Date().toISOString(); await rememberPublish(sid, key, record, env);
  const updated = await fetchPublishStatus(token, record, key, env);
  return { job_id: updated.job_id, status: updated.last_tiktok_publish_status, privacy_level: updated.privacy_level };
}
async function directPostStatus(request, env) {
  const { sid, token } = await tokenFor(request, env); const latest = await loadPublish(latestPublishKey(sid), env);
  if (!latest?.key) throw new Error("No persisted TikTok publish is available for this session.");
  const record = await loadPublish(latest.key, env); if (!record?.publish_id) throw new Error("The persisted publish has no TikTok publish_id yet.");
  const updated = await fetchPublishStatus(token, record, latest.key, env);
  return { job_id: updated.job_id, status: updated.last_tiktok_publish_status, privacy_level: updated.privacy_level };
}
async function preflight(request, env) {
  const { token } = await tokenFor(request, env); const form = await request.formData(); const file = form.get("video");
  if (!(file instanceof File) || file.type !== "video/mp4" || !file.size) throw new Error("Choose a non-empty MP4 video.");
  if (file.size > MAX_DEMO_BYTES) throw new Error("This sandbox flow accepts videos up to 20 MB.");
  if (form.get("confirmed") !== "true") throw new Error("Explicit confirmation is required before preflight.");
  const creator = await creatorInfo(token); const privacy = String(form.get("privacy_level") || "");
  if (!privacy || !creator.privacy_level_options?.includes(privacy)) throw new Error("Choose a current privacy option returned by TikTok.");
  const duration = Number(form.get("duration_seconds")); if (!Number.isFinite(duration) || duration <= 0 || (creator.max_video_post_duration_sec && duration > creator.max_video_post_duration_sec)) throw new Error("The video duration is not permitted for this creator.");
  return { creator: creator.creator_nickname || creator.creator_username, privacy_level: privacy, video_bytes: file.size, publish_call_made: false };
}
export default { async fetch(request, env) {
  const url = new URL(request.url); const headers = cors(request, env); if (request.method === "OPTIONS") return new Response(null, { headers });
  try {
    if (url.pathname === "/health") return json({ ok: true }, 200, headers);
    if (url.pathname === "/oauth/start") { const sid = random(), state = random(); const params = new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, response_type: "code", scope: "user.info.basic,video.publish", redirect_uri: `${env.API_ORIGIN}/oauth/callback`, state }); return new Response(null, { status: 302, headers: { Location: `${TIKTOK_AUTH}?${params}`, "Set-Cookie": `cp_oauth_state=${state}:${sid}; Path=/oauth/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax` } }); }
    if (url.pathname === "/oauth/callback") { const state = url.searchParams.get("state"), code = url.searchParams.get("code"), stateCookie = cookie(request, "cp_oauth_state"); const [cookieState, sid] = (stateCookie || ":").split(":"); if (!state || !code || state !== cookieState || !sid) return new Response("OAuth validation failed.", { status: 400 }); const form = new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, code, grant_type: "authorization_code", redirect_uri: `${env.API_ORIGIN}/oauth/callback` }); const response = await fetch(TIKTOK_TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form }); const rawText = await response.text(); let raw = null; try { raw = JSON.parse(rawText); } catch {} const token = normalizeToken(raw); const missing = ["access_token", "refresh_token"].filter(field => !token[field]); if (!response.ok || !raw || raw.error || missing.length) return json({ ERROR: raw?.error ?? null, ERROR_DESCRIPTION: raw?.error_description ?? null, LOG_ID: raw?.log_id ?? null, HTTP_STATUS: response.status, TOKEN_ENDPOINT: TIKTOK_TOKEN }, 502); token.expires_at = Date.now() + token.expires_in * 1000; await env.TOKENS.put(`session:${sid}`, await seal(token, env), { expirationTtl: Math.min(token.refresh_expires_in || 2_592_000, 31_536_000) }); return new Response(null, { status: 302, headers: { Location: `${env.APP_ORIGIN}/?connected=1#session=${sid}`, "Set-Cookie": "cp_oauth_state=; Path=/oauth/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax" } }); }
    if (request.method === "POST" && url.pathname === "/api/creator-info") { const { token } = await tokenFor(request, env); return json({ user: await userInfo(token), creator: await creatorInfo(token) }, 200, headers); }
    if (request.method === "POST" && url.pathname === "/api/token-refresh-check") { const sid = sessionId(request); if (!sid) throw new Error("Connect TikTok before continuing."); const stored = await env.TOKENS.get(`session:${sid}`); if (!stored) throw new Error("Your TikTok session has expired. Connect TikTok again."); const refreshed = await refreshToken(sid, await unseal(stored, env), env); return json({ refreshed: true, scopes: refreshed.scope || "" }, 200, headers); }
    if (request.method === "POST" && url.pathname === "/api/direct-post/preflight") return json(await preflight(request, env), 200, headers);
    if (request.method === "POST" && url.pathname === "/api/direct-post/prepare") return json(await prepareDirectPost(request, env), 200, headers);
    if (request.method === "POST" && url.pathname === "/api/direct-post/upload") return json(await uploadDirectPost(request, env), 200, headers);
    if (request.method === "POST" && url.pathname === "/api/direct-post/status") return json(await directPostStatus(request, env), 200, headers);
    return json({ error: "Not found" }, 404, headers);
  } catch (error) { return json({ error: error.message || "Unexpected server error." }, 400, headers); }
} };
