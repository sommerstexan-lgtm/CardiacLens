/**
 * CardiacLens Ask Worker — Grok (xAI) edition
 * Version target: CardiacLens 9.10.348.220+
 *
 * Contract (unchanged from Claude Worker):
 *   POST /ask  { system: string, messages: Array<{role, content}> }
 *   Success:   { content: [{ type: "text", text: string }], stop_reason: "end_turn"|"max_tokens"|... }
 *   Daily limit: 429 { error: "daily_limit_reached" }
 *   CORS: * for the app origin
 *
 * Secrets required (wrangler secret put ...):
 *   XAI_API_KEY
 *
 * Optional KV binding (for daily limit):
 *   ASK_LIMITS  (KV namespace)
 *
 * Deploy notes:
 *   - Keep the same route /ask
 *   - Model: grok-4.5 (or change MODEL constant)
 *   - Attachment handling: Anthropic-style content blocks are converted.
 *     Images (jpeg/png) → Grok vision image_url.
 *     PDF "document" blocks → currently rejected with a clear message
 *     (native PDF requires xAI Files API + multi-step; can be added later).
 */

const MODEL = "grok-4.5";
const XAI_CHAT_URL = "https://api.x.ai/v1/chat/completions";
const DAILY_LIMIT = 10; // questions per calendar day (UTC)
const MAX_OUTPUT_TOKENS = 4096;
const TEMPERATURE = 0.25; // low for precision / reduced guessing
const REASONING_EFFORT = "medium"; // careful data analysis without excessive latency

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const url = new URL(request.url);
    // Accept both /ask and root for flexibility
    if (url.pathname !== "/ask" && url.pathname !== "/") {
      return json({ error: "Not found" }, 404);
    }

    if (!env.XAI_API_KEY) {
      return json({ error: "Server misconfigured: missing XAI_API_KEY" }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const system = typeof body.system === "string" ? body.system : "";
    let messages = Array.isArray(body.messages) ? body.messages : [];

    if (!system && messages.length === 0) {
      return json({ error: "Missing system or messages" }, 400);
    }

    // ── Daily limit (optional KV) ──────────────────────────────────────────
    const clientKey = getClientKey(request);
    if (env.ASK_LIMITS) {
      const limitResult = await checkAndIncrementLimit(env.ASK_LIMITS, clientKey);
      if (limitResult.blocked) {
        return json({ error: "daily_limit_reached" }, 429);
      }
    }

    // ── Convert Anthropic-style messages → OpenAI/Grok chat format ────────
    const converted = convertMessages(messages);
    if (converted.error) {
      // Soft failure for unsupported attachment so client still gets a usable reply
      return json({
        content: [{ type: "text", text: converted.error }],
        stop_reason: "end_turn",
      });
    }

    const grokMessages = [];
    if (system) {
      grokMessages.push({ role: "system", content: system });
    }
    grokMessages.push(...converted.messages);

    // ── Call xAI ───────────────────────────────────────────────────────────
    let xaiResp;
    try {
      xaiResp = await fetch(XAI_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.XAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: grokMessages,
          temperature: TEMPERATURE,
          max_completion_tokens: MAX_OUTPUT_TOKENS,
          reasoning_effort: REASONING_EFFORT,
          stream: false,
        }),
      });
    } catch (err) {
      console.error("xAI fetch error", err);
      return json({ error: "Upstream request failed" }, 502);
    }

    if (!xaiResp.ok) {
      const errText = await xaiResp.text().catch(() => "");
      console.error("xAI error", xaiResp.status, errText.slice(0, 500));
      // Map common upstream statuses so client offline / busy banners still work
      if (xaiResp.status === 429) {
        return json({ error: "rate_limited" }, 429);
      }
      if (xaiResp.status >= 500) {
        return json({ error: "Upstream busy" }, 503);
      }
      return json(
        { error: `xAI ${xaiResp.status}: ${errText.slice(0, 200)}` },
        502
      );
    }

    let data;
    try {
      data = await xaiResp.json();
    } catch {
      return json({ error: "Invalid upstream JSON" }, 502);
    }

    // ── Map OpenAI-style response → Claude-compatible shape the client expects
    const choice = data.choices && data.choices[0];
    const text =
      (choice && choice.message && choice.message.content) ||
      (choice && choice.text) ||
      "";
    const finish = (choice && choice.finish_reason) || "stop";

    // Client looks for stop_reason === "max_tokens"
    const stop_reason =
      finish === "length" || finish === "max_tokens" ? "max_tokens" : "end_turn";

    return json(
      {
        content: [{ type: "text", text: String(text).trim() }],
        stop_reason,
        // optional debug (client ignores)
        model: data.model || MODEL,
        usage: data.usage || null,
      },
      200
    );
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function getClientKey(request) {
  // Prefer CF connecting IP; fall back to a static key if missing
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "anonymous"
  );
}

async function checkAndIncrementLimit(kv, clientKey) {
  const day = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const key = `ask:${day}:${clientKey}`;
  let count = 0;
  try {
    const raw = await kv.get(key);
    count = raw ? parseInt(raw, 10) || 0 : 0;
  } catch (e) {
    console.error("KV get error", e);
    return { blocked: false }; // fail open
  }
  if (count >= DAILY_LIMIT) {
    return { blocked: true };
  }
  try {
    // TTL ~ 2 days so old keys auto-expire
    await kv.put(key, String(count + 1), { expirationTtl: 172800 });
  } catch (e) {
    console.error("KV put error", e);
  }
  return { blocked: false };
}

/**
 * Convert client messages (Claude / Anthropic content-block style) to
 * Grok/OpenAI chat.completions format.
 * Supports:
 *   - plain string content
 *   - content array with {type:"text", text} and {type:"image", source:{type:"base64", media_type, data}}
 * Rejects PDF document blocks with a clear user-facing message.
 */
function convertMessages(messages) {
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role === "assistant" ? "assistant" : "user";

    // Plain string (most common path)
    if (typeof msg.content === "string") {
      out.push({ role, content: msg.content });
      continue;
    }

    // Content array (attachments)
    if (Array.isArray(msg.content)) {
      const parts = [];
      let hasUnsupportedPdf = false;

      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;

        if (block.type === "text" && typeof block.text === "string") {
          parts.push({ type: "text", text: block.text });
          continue;
        }

        // Anthropic image block → OpenAI image_url
        if (
          block.type === "image" &&
          block.source &&
          block.source.type === "base64" &&
          block.source.data
        ) {
          const media = (block.source.media_type || "image/jpeg").toLowerCase();
          if (media === "image/jpeg" || media === "image/png" || media === "image/jpg") {
            parts.push({
              type: "image_url",
              image_url: {
                url: `data:${media};base64,${block.source.data}`,
                detail: "high",
              },
            });
          } else {
            // unsupported image type
            parts.push({
              type: "text",
              text: `[Unsupported image type: ${media}. Only JPEG and PNG are supported.]`,
            });
          }
          continue;
        }

        // Anthropic document (PDF) — not supported in single-shot chat.completions
        if (block.type === "document") {
          hasUnsupportedPdf = true;
          continue;
        }

        // Unknown block — ignore
      }

      if (hasUnsupportedPdf) {
        return {
          error:
            "PDF attachments are not yet supported with the new Ask engine (Grok). " +
            "Please either (1) describe the relevant section of the document in your question, " +
            "or (2) take a clear photo/screenshot of the page and attach that image instead. " +
            "Image attachments (JPEG/PNG) work normally.",
        };
      }

      if (parts.length === 0) {
        out.push({ role, content: "" });
      } else if (parts.length === 1 && parts[0].type === "text") {
        out.push({ role, content: parts[0].text });
      } else {
        out.push({ role, content: parts });
      }
      continue;
    }

    // Fallback
    out.push({ role, content: String(msg.content || "") });
  }
  return { messages: out };
}
