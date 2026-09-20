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
async function encryptionKey(env) { return crypto.subtle.importKey("raw", bytes(env.TOKEN_ENCRYPTION_KEY_BASE64), "AES-GCM", false, ["encrypt", "decrypt"]); }
async function seal(value, env) { const iv = crypto.getRandomValues(new Uint8Array(12)); const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), new TextEncoder().encode(JSON.stringify(value))); return JSON.stringify({ iv: b64(iv), data: b64(encrypted) }); }
async function unseal(value, env) { const payload = JSON.parse(value); const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(payload.iv) }, await encryptionKey(env), bytes(payload.data)); return JSON.parse(new TextDecoder().decode(clear)); }
function cors(request, env) { const origin = request.headers.get("Origin"); return origin === env.APP_ORIGIN ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin" } : {}; }
function sessionId(request) { const auth = request.headers.get("Authorization") || ""; return auth.startsWith("Bearer ") ? auth.slice(7) : null; }
async function tokenFor(request, env) {
  const sid = sessionId(request); if (!sid) throw new Error("Connect TikTok before continuing.");
  const stored = await env.TOKENS.get(`session:${sid}`); if (!stored) throw new Error("Your TikTok session has expired. Connect TikTok again.");
  let token = await unseal(stored, env);
  if (Date.now() < token.expires_at - 60_000) return { sid, token };
  const form = new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: token.refresh_token });
  const response = await fetch(TIKTOK_TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form }); const refreshed = await response.json();
  if (!response.ok) throw new Error(refreshed.error_description || "TikTok token refresh failed.");
  token = { ...refreshed, expires_at: Date.now() + refreshed.expires_in * 1000 }; await env.TOKENS.put(`session:${sid}`, await seal(token, env), { expirationTtl: Math.min(refreshed.refresh_expires_in || 2_592_000, 31_536_000) }); return { sid, token };
}
async function creatorInfo(token) { const response = await fetch(CREATOR_INFO, { method: "POST", headers: { Authorization: `Bearer ${token.access_token}`, "content-type": "application/json; charset=UTF-8" }, body: "{}" }); const result = await response.json(); if (!response.ok || result.error?.code !== "ok") throw new Error(result.error?.message || "TikTok creator info request failed."); return result.data; }
async function userInfo(token) { const response = await fetch(USER_INFO, { headers: { Authorization: `Bearer ${token.access_token}` } }); const result = await response.json(); if (!response.ok || result.error?.code !== "ok") throw new Error(result.error?.message || "TikTok user info request failed."); return result.data.user; }
async function upload(request, env) {
  const { token } = await tokenFor(request, env); const form = await request.formData(); const file = form.get("video");
  if (!(file instanceof File) || file.type !== "video/mp4" || !file.size) throw new Error("Choose a non-empty MP4 video.");
  if (file.size > MAX_DEMO_BYTES) throw new Error("This sandbox flow accepts videos up to 20 MB.");
  if (form.get("confirmed") !== "true") throw new Error("Explicit confirmation is required before a video can be sent.");
  const creator = await creatorInfo(token); const privacy = String(form.get("privacy_level") || "");
  if (!privacy || !creator.privacy_level_options?.includes(privacy)) throw new Error("Choose a current privacy option returned by TikTok.");
  const duration = Number(form.get("duration_seconds")); if (!Number.isFinite(duration) || duration <= 0 || (creator.max_video_post_duration_sec && duration > creator.max_video_post_duration_sec)) throw new Error("The video duration is not permitted for this creator.");
  const enabled = name => form.get(name) === "true";
  const postInfo = { title: String(form.get("title") || ""), privacy_level: privacy, disable_comment: creator.comment_disabled ? true : !enabled("allow_comments"), disable_duet: creator.duet_disabled ? true : !enabled("allow_duet"), disable_stitch: creator.stitch_disabled ? true : !enabled("allow_stitch"), brand_content_toggle: enabled("brand_content"), brand_organic_toggle: enabled("brand_organic"), is_aigc: enabled("is_aigc") };
  const init = await fetch(VIDEO_INIT, { method: "POST", headers: { Authorization: `Bearer ${token.access_token}`, "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify({ post_info: postInfo, source_info: { source: "FILE_UPLOAD", video_size: file.size, chunk_size: file.size, total_chunk_count: 1 } }) }); const initialized = await init.json();
  if (!init.ok || initialized.error?.code !== "ok") throw new Error(initialized.error?.message || "TikTok Direct Post initialization failed.");
  const put = await fetch(initialized.data.upload_url, { method: "PUT", headers: { "content-type": "video/mp4", "content-length": String(file.size), "content-range": `bytes 0-${file.size - 1}/${file.size}` }, body: file.stream() });
  if (!put.ok) throw new Error("TikTok video upload failed.");
  const statusResponse = await fetch(STATUS_FETCH, { method: "POST", headers: { Authorization: `Bearer ${token.access_token}`, "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify({ publish_id: initialized.data.publish_id }) }); const status = await statusResponse.json();
  return { publish_id: initialized.data.publish_id, status: status.data?.status || "processing" };
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
    if (url.pathname === "/oauth/start") { const sid = random(), state = random(); await env.TOKENS.put(`state:${state}`, sid, { expirationTtl: 600 }); const params = new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, response_type: "code", scope: "user.info.basic,video.publish", redirect_uri: `${env.API_ORIGIN}/oauth/callback`, state }); return Response.redirect(`${TIKTOK_AUTH}?${params}`, 302); }
    if (url.pathname === "/oauth/callback") { const state = url.searchParams.get("state"), code = url.searchParams.get("code"); const sid = state && await env.TOKENS.get(`state:${state}`); if (!sid || !code) return new Response("OAuth validation failed.", { status: 400 }); await env.TOKENS.delete(`state:${state}`); const form = new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, code, grant_type: "authorization_code", redirect_uri: `${env.API_ORIGIN}/oauth/callback` }); const response = await fetch(TIKTOK_TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form }); const token = await response.json(); if (!response.ok) return new Response("TikTok token exchange failed.", { status: 502 }); token.expires_at = Date.now() + token.expires_in * 1000; await env.TOKENS.put(`session:${sid}`, await seal(token, env), { expirationTtl: Math.min(token.refresh_expires_in || 2_592_000, 31_536_000) }); return Response.redirect(`${env.APP_ORIGIN}/?connected=1#session=${sid}`, 302); }
    if (request.method === "POST" && url.pathname === "/api/creator-info") { const { token } = await tokenFor(request, env); return json({ user: await userInfo(token), creator: await creatorInfo(token) }, 200, headers); }
    if (request.method === "POST" && url.pathname === "/api/direct-post/preflight") return json(await preflight(request, env), 200, headers);
    return json({ error: "Not found" }, 404, headers);
  } catch (error) { return json({ error: error.message || "Unexpected server error." }, 400, headers); }
} };
