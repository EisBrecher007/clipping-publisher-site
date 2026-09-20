(() => {
  const apiOrigin = (window.CLIPPING_PUBLISHER_API_ORIGIN || "").replace(/\/$/, "");
  const $ = id => document.getElementById(id);
  const sessionKey = "clipping_publisher_review_session";
  const query = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.get("session")) { sessionStorage.setItem(sessionKey, fragment.get("session")); history.replaceState({}, "", location.pathname + location.search); }
  const session = () => sessionStorage.getItem(sessionKey);
  const request = async (path, init = {}) => {
    if (!apiOrigin) throw new Error("Sandbox backend is not configured yet.");
    const response = await fetch(apiOrigin + path, { ...init, headers: { ...(init.headers || {}), ...(session() ? { Authorization: `Bearer ${session()}` } : {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "TikTok request failed.");
    return body;
  };
  const setStatus = text => { $("status").textContent = text; };
  const enableConnectedFlow = async () => {
    $("connection-copy").textContent = "Connected to TikTok Sandbox.";
    $("connect").textContent = "TikTok connected"; $("connect").disabled = true;
    $("video-section").hidden = false; $("settings-section").hidden = false; $("consent-section").hidden = false;
    try {
      const { creator } = await request("/api/creator-info", { method: "POST" });
      $("creator-summary").textContent = `Posting as ${creator.creator_nickname || creator.creator_username}. Choose one of the privacy options returned by TikTok.`;
      for (const option of creator.privacy_level_options || []) { const el = document.createElement("option"); el.value = option; el.textContent = option.replaceAll("_", " "); $("privacy").append(el); }
      [["allow-comments", creator.comment_disabled], ["allow-duet", creator.duet_disabled], ["allow-stitch", creator.stitch_disabled]].forEach(([id, disabled]) => { const input = $(id); input.disabled = Boolean(disabled); if (disabled) input.parentElement.append(" (unavailable for this creator)"); });
      $("settings-section").dataset.maxDuration = creator.max_video_post_duration_sec || "";
    } catch (error) { setStatus(error.message); }
  };
  $("connect").addEventListener("click", () => { if (!apiOrigin) return setStatus("Sandbox backend is not configured yet."); location.assign(apiOrigin + "/oauth/start"); });
  $("video").addEventListener("change", () => { const file = $("video").files[0]; $("video-summary").textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : ""; });
  $("caption").addEventListener("input", () => { $("caption-count").textContent = $("caption").value.length; });
  $("consent").addEventListener("change", () => { $("publish").disabled = !$("consent").checked; });
  $("publish").addEventListener("click", async () => {
    const file = $("video").files[0];
    if (!file) return setStatus("Choose a prepared MP4 first.");
    if (!$("privacy").value) return setStatus("Choose a TikTok privacy setting.");
    const video = document.createElement("video"); video.preload = "metadata"; video.src = URL.createObjectURL(file); await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject; });
    const max = Number($("settings-section").dataset.maxDuration || 0); if (max && video.duration > max) return setStatus(`This video exceeds the creator's ${max}-second limit.`);
    const form = new FormData(); form.append("video", file); form.append("title", $("caption").value); form.append("privacy_level", $("privacy").value); form.append("allow_comments", $("allow-comments").checked); form.append("allow_duet", $("allow-duet").checked); form.append("allow_stitch", $("allow-stitch").checked); form.append("brand_content", $("brand-content").checked); form.append("brand_organic", $("brand-organic").checked); form.append("is_aigc", $("ai-generated").checked); form.append("duration_seconds", String(video.duration)); form.append("confirmed", "true");
    $("publish").disabled = true; setStatus("Initializing official TikTok Direct Post…");
    try { const result = await request("/api/direct-post", { method: "POST", body: form }); setStatus(`TikTok accepted the upload. Publish ID: ${result.publish_id}. Status: ${result.status || "processing"}.`); } catch (error) { setStatus(error.message); $("publish").disabled = false; }
  });
  if (query.get("connected") === "1" && session()) enableConnectedFlow();
})();
