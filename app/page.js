"use client";

import { useEffect, useRef, useState } from "react";

const DEFAULT_TEXT =
  "Hello, thank you for calling customer support. I'm happy to help you today. Could you please explain the issue you're experiencing?";

const SAMPLE_RATES = [8000, 16000, 24000, 44100];

function base64ToBytes(base64) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function createWavBlob(pcmChunks, sampleRate) {
  const totalBytes = pcmChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const pcm = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of pcmChunks) {
    pcm.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeText = (position, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(position + index, value.charCodeAt(index));
    }
  };

  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;

  writeText(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeText(36, "data");
  view.setUint32(40, pcm.byteLength, true);

  return new Blob([header, pcm], { type: "audio/wav" });
}

function parseSseFrame(frame) {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");

  if (!data) return null;
  return JSON.parse(data);
}

export default function HomePage() {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [voiceId, setVoiceId] = useState("zariya");
  const [model, setModel] = useState("lightning_v3.1_pro");
  const [language, setLanguage] = useState("auto");
  const [speed, setSpeed] = useState(1);
  const [sampleRate, setSampleRate] = useState(24000);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [metrics, setMetrics] = useState(null);
  const [playbackStatus, setPlaybackStatus] = useState("Ready to stream");
  const [chunkCount, setChunkCount] = useState(0);

  const audioContextRef = useRef(null);
  const nextStartTimeRef = useRef(0);
  const sourceNodesRef = useRef(new Set());
  const abortControllerRef = useRef(null);
  const downloadUrlRef = useRef("");
  const streamStartedAtRef = useRef(0);
  const firstAudioAtRef = useRef(null);
  const pcmChunksRef = useRef([]);
  const streamCompleteRef = useRef(false);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      for (const source of sourceNodesRef.current) {
        try { source.stop(); } catch { /* It may already have stopped. */ }
      }
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        audioContextRef.current.close();
      }
    };
  }, []);

  function setDownload(blob) {
    if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    const nextUrl = URL.createObjectURL(blob);
    downloadUrlRef.current = nextUrl;
    setDownloadUrl(nextUrl);
  }

  function clearDownload() {
    if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    downloadUrlRef.current = "";
    setDownloadUrl("");
  }

  function stopScheduledAudio() {
    for (const source of sourceNodesRef.current) {
      try { source.stop(); } catch { /* Ignore already-ended sources. */ }
    }
    sourceNodesRef.current.clear();
    if (audioContextRef.current) {
      nextStartTimeRef.current = audioContextRef.current.currentTime;
    }
  }

  function queuePcmForPlayback(bytes) {
    const context = audioContextRef.current;
    if (!context) throw new Error("Audio playback is not initialized.");

    // Waves PCM chunks are signed 16-bit, mono samples.
    const usableLength = bytes.byteLength - (bytes.byteLength % 2);
    if (usableLength === 0) return;

    const samples = usableLength / 2;
    const audioBuffer = context.createBuffer(1, samples, Number(sampleRate));
    const channel = audioBuffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, usableLength);

    for (let index = 0; index < samples; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 32768;
    }

    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);

    const safeStart = Math.max(nextStartTimeRef.current, context.currentTime + 0.025);
    source.start(safeStart);
    nextStartTimeRef.current = safeStart + audioBuffer.duration;
    sourceNodesRef.current.add(source);

    source.onended = () => {
      sourceNodesRef.current.delete(source);
      if (streamCompleteRef.current && sourceNodesRef.current.size === 0) {
        setPlaybackStatus("Playback finished");
      }
    };
  }

  async function handleGenerate(event) {
    event.preventDefault();
    setError("");
    setMetrics(null);
    setChunkCount(0);
    clearDownload();

    const trimmedText = text.trim();
    if (!trimmedText) {
      setError("Enter some text before generating speech.");
      return;
    }
    if (trimmedText.length > 8000) {
      setError("Text must be 8,000 characters or fewer.");
      return;
    }
    if (!voiceId.trim()) {
      setError("Enter a voice ID. Copy the exact ID from the Smallest.ai playground.");
      return;
    }

    abortControllerRef.current?.abort();
    stopScheduledAudio();
    pcmChunksRef.current = [];
    firstAudioAtRef.current = null;
    streamCompleteRef.current = false;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    streamStartedAtRef.current = performance.now();
    nextStartTimeRef.current = 0;

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("This browser does not support Web Audio playback.");
      if (!audioContextRef.current || audioContextRef.current.state === "closed") {
        audioContextRef.current = new AudioContextClass();
      }
      await audioContextRef.current.resume();

      setIsStreaming(true);
      setPlaybackStatus("Connecting to Waves streaming API…");

      const response = await fetch("/api/tts/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream"
        },
        body: JSON.stringify({
          text: trimmedText,
          voice_id: voiceId.trim(),
          model,
          language,
          speed: Number(speed),
          sample_rate: Number(sampleRate)
        }),
        signal: controller.signal,
        cache: "no-store"
      });

      if (!response.ok) {
        let message = `Streaming failed (HTTP ${response.status}).`;
        try {
          const payload = await response.json();
          if (payload?.error) message = payload.error;
        } catch {
          // Keep generic status text if the response is not JSON.
        }
        throw new Error(message);
      }
      if (!response.body) throw new Error("The browser did not receive a readable audio stream.");

      setPlaybackStatus("Waiting for first audio chunk…");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let receivedChunks = 0;
      let finished = false;

      const handleFrame = (frame) => {
        const message = parseSseFrame(frame);
        if (!message) return;

        if (message.error || Number(message.status) >= 400) {
          throw new Error(message.error || message.message || `Waves stream error (${message.status}).`);
        }

        if (message.done === true) {
          finished = true;
          return;
        }

        if (typeof message.audio === "string" && message.audio.length > 0) {
          const bytes = base64ToBytes(message.audio);
          if (firstAudioAtRef.current === null) {
            firstAudioAtRef.current = performance.now();
            const ttfaMs = Math.round(firstAudioAtRef.current - streamStartedAtRef.current);
            setPlaybackStatus(`Speaking · first audio in ${ttfaMs} ms`);
          }

          pcmChunksRef.current.push(bytes);
          queuePcmForPlayback(bytes);
          receivedChunks += 1;
          setChunkCount(receivedChunks);
        }
      };

      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });

        let separatorIndex;
        while ((separatorIndex = pending.search(/\r?\n\r?\n/)) !== -1) {
          const frame = pending.slice(0, separatorIndex);
          const separator = pending.slice(separatorIndex).match(/^\r?\n\r?\n/)[0];
          pending = pending.slice(separatorIndex + separator.length);
          handleFrame(frame);
          if (finished) break;
        }
      }

      if (!finished && pending.trim()) handleFrame(pending);
      if (!finished) {
        throw new Error("The streaming connection closed before Waves sent its completion event.");
      }
      if (receivedChunks === 0) {
        throw new Error("The stream completed without any audio chunks.");
      }

      streamCompleteRef.current = true;
      const wavBlob = createWavBlob(pcmChunksRef.current, Number(sampleRate));
      setDownload(wavBlob);

      const totalMs = Math.round(performance.now() - streamStartedAtRef.current);
      const ttfaMs = firstAudioAtRef.current
        ? Math.round(firstAudioAtRef.current - streamStartedAtRef.current)
        : null;

      setMetrics({
        ttfaMs,
        totalMs,
        chunks: receivedChunks,
        bytes: wavBlob.size,
        sampleRate
      });

      setPlaybackStatus(sourceNodesRef.current.size > 0 ? "Stream complete · finishing playback" : "Playback finished");
    } catch (err) {
      if (err?.name === "AbortError") {
        setPlaybackStatus("Stream cancelled");
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong while streaming speech.");
        setPlaybackStatus("Stream failed");
      }
      streamCompleteRef.current = false;
      stopScheduledAudio();
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  }

  function handleCancel() {
    abortControllerRef.current?.abort();
    stopScheduledAudio();
    setIsStreaming(false);
    setPlaybackStatus("Cancelling stream…");
  }

  const characterCount = text.length;

  return (
    <main className="page-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">W</div>
        <div>
          <p className="eyebrow">SMALLEST.AI · WAVES</p>
          <h1>Streaming Text to Speech Playground</h1>
        </div>
        <span className="topbar-pill">Next.js demo</span>
      </header>

      <section className="intro-card">
        <div>
          <p className="eyebrow">LIGHTNING V3.1 PRO · SSE STREAMING</p>
          <h2>Speak while the audio is being generated.</h2>
          <p className="intro-copy">
            Click Generate & Speak. The browser plays each PCM audio chunk as soon as it arrives instead of waiting for the complete file.
          </p>
        </div>
        <div className="wave-art" aria-hidden="true">
          {Array.from({ length: 21 }, (_, index) => (
            <span key={index} style={{ "--bar": `${18 + ((index * 17) % 54)}px` }} />
          ))}
        </div>
      </section>

      <div className="content-grid">
        <form className="panel form-panel" onSubmit={handleGenerate}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">REQUEST</p>
              <h2>Speech settings</h2>
            </div>
            <span className="status-dot"><span /> Streaming API</span>
          </div>

          <label className="field-label" htmlFor="speech-text">Text to synthesize</label>
          <textarea
            id="speech-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={8000}
            rows={7}
            placeholder="Type the text you want to hear..."
            disabled={isStreaming}
          />
          <div className="field-meta">
            <span>Maximum 8,000 characters</span>
            <span>{characterCount.toLocaleString()} / 8,000</span>
          </div>

          <div className="fields-grid">
            <div className="field-group">
              <label className="field-label" htmlFor="voice-id">Voice ID</label>
              <input id="voice-id" value={voiceId} onChange={(event) => setVoiceId(event.target.value)} placeholder="e.g. zariya" autoComplete="off" disabled={isStreaming} />
              <small>Use the exact voice ID from the Smallest.ai “Use in API” dialog.</small>
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor="model">Model</label>
              <select id="model" value={model} onChange={(event) => setModel(event.target.value)} disabled={isStreaming}>
                <option value="lightning_v3.1_pro">Lightning v3.1 Pro</option>
                <option value="lightning_v3.1_pro_10_26">Lightning v3.1 Pro (10_26 preview)</option>
              </select>
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor="language">Language</label>
              <select id="language" value={language} onChange={(event) => setLanguage(event.target.value)} disabled={isStreaming}>
                <option value="auto">Auto</option>
                <option value="en">English (en)</option>
                <option value="hi">Hindi / Indian English (hi)</option>
                <option value="ta">Tamil (ta)</option>
              </select>
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor="sample-rate">Sample rate</label>
              <select id="sample-rate" value={sampleRate} onChange={(event) => setSampleRate(Number(event.target.value))} disabled={isStreaming}>
                {SAMPLE_RATES.map((rate) => <option key={rate} value={rate}>{rate.toLocaleString()} Hz</option>)}
              </select>
            </div>
          </div>

          <div className="speed-row">
            <div>
              <label className="field-label" htmlFor="speed">Speech speed</label>
              <p className="help-text">0.5× slower · 1× normal · 2× faster</p>
            </div>
            <div className="speed-control">
              <input id="speed" type="range" min="0.5" max="2" step="0.1" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} disabled={isStreaming} />
              <strong>{Number(speed).toFixed(1)}×</strong>
            </div>
          </div>

          {error && <div className="alert alert-error" role="alert">{error}</div>}

          <button className="primary-button" type="submit" disabled={isStreaming || !text.trim() || !voiceId.trim()}>
            {isStreaming ? <><span className="spinner" /> Streaming and speaking…</> : <>Generate &amp; Speak <span aria-hidden="true">▶</span></>}
          </button>
          {isStreaming && (
            <button className="cancel-button" type="button" onClick={handleCancel}>Cancel stream</button>
          )}
          <p className="footnote">The API key remains on the Next.js server. The browser receives audio chunks, never the secret key.</p>
        </form>

        <aside className="panel output-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">LIVE OUTPUT</p>
              <h2>Streaming playback</h2>
            </div>
            <span className="output-icon" aria-hidden="true">♫</span>
          </div>

          <div className={`stream-status ${isStreaming ? "stream-status-live" : ""}`} aria-live="polite">
            <span className="stream-status-dot" />
            <span>{playbackStatus}</span>
          </div>

          {isStreaming && (
            <div className="stream-progress">
              <div className="stream-progress-bar" />
              <p>{chunkCount} audio chunk{chunkCount === 1 ? "" : "s"} received · playback is scheduled as chunks arrive</p>
            </div>
          )}

          {!downloadUrl ? (
            <div className="empty-state">
              <div className="empty-icon">♫</div>
              <h3>Your voice will start here</h3>
              <p>Press Generate &amp; Speak. You should hear the first audio before the complete response has finished generating.</p>
            </div>
          ) : (
            <div className="audio-result">
              <div className="success-mark">✓</div>
              <h3>Stream captured</h3>
              <p>The complete streamed PCM response has been assembled into a WAV file.</p>
              <a className="download-button" href={downloadUrl} download="smallest-waves-stream.wav">Download full WAV <span aria-hidden="true">↓</span></a>
            </div>
          )}

          {metrics && (
            <div className="metrics-card">
              <p className="eyebrow">STREAM METRICS</p>
              <div className="metric-line"><span>Time to first audio (client)</span><strong>{metrics.ttfaMs === null ? "Not available" : `${metrics.ttfaMs} ms`}</strong></div>
              <div className="metric-line"><span>Total stream time</span><strong>{(metrics.totalMs / 1000).toFixed(2)} s</strong></div>
              <div className="metric-line"><span>Audio chunks</span><strong>{metrics.chunks}</strong></div>
              <div className="metric-line"><span>Captured WAV size</span><strong>{(metrics.bytes / 1024).toFixed(1)} KB</strong></div>
              <div className="metric-line"><span>PCM sample rate</span><strong>{Number(metrics.sampleRate).toLocaleString()} Hz</strong></div>
              <p className="metrics-note">Client TTFA is measured from clicking Generate &amp; Speak until the first audio chunk reaches this browser. It includes network and server time; it is not a provider-only latency measurement.</p>
            </div>
          )}

          <div className="info-note">
            <strong>Streaming behavior</strong>
            <p>Uses POST /waves/v1/tts/live (SSE) with PCM chunks. The UI schedules each chunk through the Web Audio API as soon as it arrives, while the remaining audio is still being generated.</p>
          </div>
        </aside>
      </div>

      <footer className="footer">
        <span>Built for real-time API evaluation</span>
        <span>Smallest.ai Waves · Streaming TTS</span>
      </footer>
    </main>
  );
}
