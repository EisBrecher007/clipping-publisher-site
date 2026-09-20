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
  const selected = id => $(id).checked;
  const availability = disabled => disabled ? "Unavailable for this creator" : "Available";
  const setCreatorDetails = (user, creator) => {
    const name = creator.creator_username || creator.creator_nickname || user.display_name || "Connected TikTok creator";
    const options = creator.privacy_level_options || [];
    $("creator-summary").textContent = `Connected as ${name}. The settings below are the current values returned by TikTok.`;
    $("creator-name").textContent = name;
    $("creator-duration").textContent = creator.max_video_post_duration_sec ? `${creator.max_video_post_duration_sec} seconds` : "Not provided by TikTok";
    $("creator-privacy-options").textContent = options.length ? options.map(option => option.replaceAll("_", " ")).join(" · ") : "No options returned";
    $("creator-comments").textContent = availability(creator.comment_disabled);
    $("creator-duet").textContent = availability(creator.duet_disabled);
    $("creator-stitch").textContent = availability(creator.stitch_disabled);
    $("creator-details").hidden = false;
    $("privacy").replaceChildren(new Option("Choose a privacy setting", ""));
    for (const option of options) { const el = document.createElement("option"); el.value = option; el.textContent = option.replaceAll("_", " "); $("privacy").append(el); }
    if (options.includes("SELF_ONLY")) $("privacy").value = "SELF_ONLY";
    [["allow-comments", creator.comment_disabled], ["allow-duet", creator.duet_disabled], ["allow-stitch", creator.stitch_disabled]].forEach(([id, disabled]) => { const input = $(id); input.disabled = Boolean(disabled); input.checked = false; });
    $("settings-section").dataset.maxDuration = creator.max_video_post_duration_sec || "";
    updateReview();
  };
  const updateReview = () => {
    const file = $("video").files[0];
    $("review-video").textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : "No video selected";
    $("review-privacy").textContent = $("privacy").value ? $("privacy").value.replaceAll("_", " ") : "Choose a TikTok setting";
    $("review-caption").textContent = $("caption").value.trim() || "No caption";
    $("review-interactions").textContent = `Comments: ${selected("allow-comments") ? "on" : "off"} · Duet: ${selected("allow-duet") ? "on" : "off"} · Stitch: ${selected("allow-stitch") ? "on" : "off"}`;
    const disclosures = [["brand-content", "Paid partnership"], ["brand-organic", "Own business"], ["ai-generated", "AI-generated"]].filter(([id]) => selected(id)).map(([, label]) => label);
    $("review-disclosure").textContent = disclosures.join(" · ") || "None selected";
  };
  const enableConnectedFlow = async () => {
    $("connection-copy").textContent = "Connected to TikTok Sandbox.";
    $("connect").textContent = "TikTok connected"; $("connect").disabled = true;
    $("video-section").hidden = false; $("settings-section").hidden = false; $("consent-section").hidden = false;
    try {
      if (query.get("refresh_check") === "1") {
        const refresh = await request("/api/token-refresh-check", { method: "POST" });
        if (!refresh.refreshed || !String(refresh.scopes || "").includes("video.publish")) throw new Error("TikTok token refresh validation failed.");
      }
      const { user, creator } = await request("/api/creator-info", { method: "POST" }); setCreatorDetails(user, creator);
    } catch (error) { $("creator-summary").textContent = "Creator settings could not be loaded. Reconnect TikTok to continue."; setStatus(error.message); }
  };
  $("connect").addEventListener("click", () => { if (!apiOrigin) return setStatus("Sandbox backend is not configured yet."); location.assign(apiOrigin + "/oauth/start"); });
  $("video").addEventListener("change", () => { const file = $("video").files[0]; $("video-summary").textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : ""; updateReview(); });
  $("caption").addEventListener("input", () => { $("caption-count").textContent = $("caption").value.length; updateReview(); });
  ["privacy", "allow-comments", "allow-duet", "allow-stitch", "brand-content", "brand-organic", "ai-generated"].forEach(id => $(id).addEventListener("change", updateReview));
  let uploadPrepared = false;
  const directPostForm = async confirmed => {
    const file = $("video").files[0];
    if (!file) throw new Error("Choose a prepared MP4 first.");
    if (!$("privacy").value) throw new Error("Choose a TikTok privacy setting.");
    const video = document.createElement("video"); video.preload = "metadata"; video.src = URL.createObjectURL(file); await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject; });
    const max = Number($("settings-section").dataset.maxDuration || 0); if (max && video.duration > max) throw new Error(`This video exceeds the creator's ${max}-second limit.`);
    const form = new FormData(); form.append("video", file); form.append("title", $("caption").value); form.append("privacy_level", $("privacy").value); form.append("allow_comments", $("allow-comments").checked); form.append("allow_duet", $("allow-duet").checked); form.append("allow_stitch", $("allow-stitch").checked); form.append("brand_content", $("brand-content").checked); form.append("brand_organic", $("brand-organic").checked); form.append("is_aigc", $("ai-generated").checked); form.append("duration_seconds", String(video.duration)); form.append("confirmed", "true");
    form.set("confirmed", String(confirmed)); return form;
  };
  $("consent").addEventListener("change", () => { $("publish").disabled = !uploadPrepared || !$("consent").checked; });
  $("prepare").addEventListener("click", async () => {
    $("prepare").disabled = true; setStatus("Initializing the official TikTok Sandbox Direct Post…");
    try { const result = await request("/api/direct-post/prepare", { method: "POST", body: await directPostForm(false) }); if (!result.publish_id_persisted || !result.upload_ready) throw new Error("TikTok publish_id was not safely persisted."); uploadPrepared = true; $("consent").disabled = false; setStatus("TikTok Direct Post initialized. Its publish ID is securely stored and verified. Final confirmation is required before upload."); } catch (error) { setStatus(error.message); $("prepare").disabled = false; }
  });
  $("publish").addEventListener("click", async () => {
    if (!uploadPrepared || !$("consent").checked) return;
    $("publish").disabled = true; setStatus("Uploading the prepared private Sandbox video…");
    try {
      let result = await request("/api/direct-post/upload", { method: "POST", body: await directPostForm(true) });
      for (let attempt = 0; attempt < 24 && !["PUBLISH_COMPLETE", "FAILED"].includes(result.status); attempt++) { await new Promise(resolve => setTimeout(resolve, 5000)); result = await request("/api/direct-post/status", { method: "POST" }); }
      setStatus(`Private Sandbox post status: ${result.status}.`);
    } catch (error) { setStatus(error.message); }
  });
  if (query.get("connected") === "1" && session()) enableConnectedFlow();
})();
