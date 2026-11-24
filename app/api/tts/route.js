import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAVES_TTS_URL = "https://api.smallest.ai/waves/v1/tts";
const ALLOWED_MODELS = new Set([
  "lightning_v3.1_pro",
  "lightning_v3.1_pro_10_26"
]);
const ALLOWED_SAMPLE_RATES = new Set([8000, 16000, 24000, 44100]);
const ALLOWED_OUTPUT_FORMATS = new Set(["wav", "mp3"]);

function jsonError(message, status) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request) {
  const apiKey = process.env.SMALLEST_API_KEY;
  if (!apiKey) {
    return jsonError("SMALLEST_API_KEY is missing. Add it to .env.local and restart the Next.js server.", 500);
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON.", 400);
  }

  const text = typeof input?.text === "string" ? input.text.trim() : "";
  const voiceId = typeof input?.voice_id === "string" ? input.voice_id.trim() : "";
  const model = typeof input?.model === "string" ? input.model : "lightning_v3.1_pro";
  const language = typeof input?.language === "string" ? input.language.trim() : "auto";
  const speed = Number(input?.speed ?? 1);
  const sampleRate = Number(input?.sample_rate ?? 44100);
  const outputFormat = typeof input?.output_format === "string" ? input.output_format : "wav";

  if (!text) return jsonError("Text is required and cannot be empty.", 400);
  if (text.length > 8000) return jsonError("Text must be 8,000 characters or fewer.", 400);
  if (!voiceId) return jsonError("voice_id is required. Use an available voice ID from your Smallest.ai account.", 400);
  if (!ALLOWED_MODELS.has(model)) return jsonError("Unsupported model. Choose a Lightning v3.1 Pro model.", 400);
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) return jsonError("Speed must be between 0.5 and 2.", 400);
  if (!ALLOWED_SAMPLE_RATES.has(sampleRate)) return jsonError("Unsupported sample rate. Choose 8000, 16000, 24000, or 44100 Hz.", 400);
  if (!ALLOWED_OUTPUT_FORMATS.has(outputFormat)) return jsonError("Unsupported output format. Choose wav or mp3.", 400);
  if (!/^(auto|[a-z]{2,3})$/i.test(language)) return jsonError("Language must be 'auto' or a 2–3 character language code.", 400);

  const payload = {
    text,
    voice_id: voiceId,
    model,
    language,
    speed,
    sample_rate: sampleRate,
    output_format: outputFormat
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  const startedAt = Date.now();

  try {
    const upstream = await fetch(WAVES_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: outputFormat === "mp3" ? "audio/mpeg" : "audio/wav"
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store"
    });

    if (!upstream.ok) {
      const providerMessage = await upstream.text();
      let readableMessage = providerMessage;
      try {
        const parsed = JSON.parse(providerMessage);
        readableMessage = parsed.error || parsed.message || providerMessage;
      } catch {
        // Keep provider's plain-text error response.
      }
      return jsonError(`Smallest.ai returned HTTP ${upstream.status}: ${readableMessage || "Request failed."}`, 502);
    }

    const audio = await upstream.arrayBuffer();
    if (!audio.byteLength) return jsonError("Smallest.ai returned an empty audio response.", 502);

    const contentType = outputFormat === "mp3" ? "audio/mpeg" : "audio/wav";
    const elapsedMs = Date.now() - startedAt;

    return new Response(audio, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(audio.byteLength),
        "Content-Disposition": `inline; filename="smallest-waves-output.${outputFormat}"`,
        "Cache-Control": "no-store",
        "X-Request-Elapsed-Ms": String(elapsedMs)
      }
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return jsonError("The Waves API request timed out after 60 seconds. Try shorter text or retry.", 504);
    }
    return jsonError("Unable to reach the Waves API. Check the server logs and try again.", 502);
  } finally {
    clearTimeout(timeout);
  }
}
