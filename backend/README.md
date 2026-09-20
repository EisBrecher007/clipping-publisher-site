# Clipping Publisher TikTok backend

This Cloudflare Worker is the server-side part of the TikTok Sandbox review flow. It keeps the TikTok client secret and OAuth tokens out of GitHub Pages. It uses only TikTok's official OAuth and Content Posting API endpoints.

Before deployment, create a Cloudflare KV namespace named `clipping-publisher-tokens`, replace its ID in `wrangler.toml`, and set the four secrets from `.dev.vars.example` with `wrangler secret put`. Generate `TOKEN_ENCRYPTION_KEY_BASE64` as a random 32-byte base64 value. Deploy with `npm install` followed by `npx wrangler deploy`, then set `window.CLIPPING_PUBLISHER_API_ORIGIN` in `../config.js` to the resulting HTTPS Worker origin.

Register `https://YOUR-WORKER-ORIGIN/oauth/callback` as the static Redirect URI in the Sandbox Login Kit configuration. Add only `video.publish` as the requested TikTok scope unless a later feature genuinely needs another scope.
