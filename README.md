# Smallest.ai Waves TTS — Next.js streaming demo

A JavaScript-only Next.js App Router project that streams speech from Smallest.ai Waves and starts browser playback as soon as the first PCM audio chunk arrives.

## Features

- Streaming `Generate & Speak` button (not generate-then-play).
- Uses `POST https://api.smallest.ai/waves/v1/tts/live` over Server-Sent Events (SSE).
- Server-side API proxy at `POST /api/tts/stream`; the Smallest API key is never exposed to client JavaScript.
- Browser decodes base64 PCM chunks and schedules them through the Web Audio API as they arrive.
- Measures client-observed time to first audio (TTFA), total stream time, chunk count, and captured WAV size.
- Reassembles received PCM chunks into a downloadable WAV after the stream completes.
- Cancel stream control and validation for empty input, 8,000-character maximum, voice ID, model, speed, sample rate, and language.
- The prior synchronous endpoint remains available at `POST /api/tts` for comparison.

## Requirements

- Node.js 20.9 or later
- A Smallest.ai API key with Waves TTS access
- A modern browser with Web Audio API support

## Setup

1. Extract the project ZIP and open the folder in a terminal.
2. Install packages:

   ```bash
   npm install
   ```

3. Create `.env.local` in the project root:

   ```env
   SMALLEST_API_KEY=your_actual_api_key
   ```

   Do not use a `NEXT_PUBLIC_` prefix. Do not commit `.env.local` to Git.

4. Start the development server:

   ```bash
   npm run dev
   ```

5. Open http://localhost:3000.

## Voice ID

The previous API snippet in your screenshot uses `voice_id: "zariya"`, so the project starts with `zariya`. Your Smallest.ai playground showed Kareena. To use exactly the same voice as the playground, open the `Use in API` dialog for Kareena and copy her actual `voice_id` into the field. The display name and API voice ID are not necessarily identical.

## Streaming architecture

```text
Browser: Generate & Speak
        |
        | POST /api/tts/stream
        v
Next.js server route (keeps API key private)
        |
        | POST https://api.smallest.ai/waves/v1/tts/live
        | Accept: text/event-stream
        v
Smallest.ai Waves SSE stream (base64 PCM chunks)
        |
        v
Next.js passes stream through without buffering
        |
        v
Browser reads SSE chunks -> base64 decode -> PCM Int16 -> Web Audio API
        |
        +--> immediate incremental playback
        +--> after completion, combine PCM into a downloadable WAV
```

The implementation uses the SSE path because this demo submits the full text in one request. Smallest.ai documents WebSocket for persistent bidirectional sessions and incrementally supplied text (for example, LLM token streams). See the official documentation below.

## Metrics

- **Client time to first audio (TTFA):** measured from the user submitting the form until the first audio chunk reaches the browser. This includes browser-to-app, app-to-provider, provider synthesis, and return network time.
- **Total stream time:** measured from submit until the SSE terminator is received.
- These are client-observed timings, not provider-only timings. Run several trials from the same network and compare p50/p95 for a meaningful QA report.

## Troubleshooting

- **`SMALLEST_API_KEY is missing`**: create `.env.local`, add your key, and restart `npm run dev`.
- **401/403**: verify the API key and Waves access.
- **400 voice/model error**: confirm the voice ID is valid for the selected model. Use the exact ID from the Smallest.ai `Use in API` dialog.
- **No audio starts**: check browser console and Next.js terminal; confirm the provider sends SSE audio events and the voice/model combination is valid.
- **Audio plays too fast/slow or is distorted**: confirm the selected sample rate matches the provider's PCM output and that the incoming payload is signed 16-bit mono PCM.
- **Browser blocks audio**: start the stream from a direct user gesture (the Generate & Speak click) and allow audio playback in the browser.

## Official references

- SSE streaming TTS: https://docs.smallest.ai/api-reference/models/text-to-speech/synthesize-speech-sse
- Streaming overview and browser/client guidance: https://docs.smallest.ai/models/text-to-speech/streaming
- WebSocket reference: https://docs.smallest.ai/api-reference/models/text-to-speech/tts
- Lightning v3.1 Pro model card: https://docs.smallest.ai/model-cards/text-to-speech/lightning-v-3-1-pro
