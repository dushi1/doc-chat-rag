"use client";

import { useCallback, useRef, useState } from "react";

const MODES = [
  { id: "answer", label: "💬 Answer" },
  { id: "summarize", label: "📝 Summarize" },
  { id: "quiz", label: "🎯 Quiz" },
];

const PLACEHOLDERS = {
  answer: "Ask a question about your documents...",
  summarize: "Optional: what should the summary focus on?",
  quiz: 'Optional: quiz focus, e.g. "expense policy only"',
};

export default function Home() {
  const [messages, setMessages] = useState([]);
  const [docs, setDocs] = useState([]);
  const [mode, setMode] = useState("answer");
  const [docId, setDocId] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [dragging, setDragging] = useState(false);

  const historyRef = useRef([]);
  const fileInputRef = useRef(null);
  const messagesRef = useRef(null);
  const streamingTextRef = useRef("");

  const scrollToBottom = useCallback(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const upsertLast = useCallback((patch) => {
    setMessages(prev => {
      const next = [...prev];
      next[next.length - 1] = { ...next[next.length - 1], ...patch };
      return next;
    });
  }, []);

  const refreshDocs = useCallback(async () => {
    const res = await fetch("/api/documents");
    setDocs(await res.json());
  }, []);

  const uploadFile = useCallback(async (file) => {
    setStatus(`Indexing "${file.name}"...`);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      const ocrNote = data.ocr ? " — OCR used for scanned pages" : "";
      setMessages(prev => [...prev, {
        role: "user",
        text: `📄 Uploaded "${data.name}" (${data.pages ? data.pages + " pages, " : ""}${data.chunks} chunks indexed${ocrNote})`,
      }]);
      await refreshDocs();
    } catch (err) {
      setMessages(prev => [...prev, { role: "error", text: err.message }]);
    } finally {
      setStatus("");
    }
  }, [refreshDocs]);

  const onFilePicked = (e) => {
    if (e.target.files[0]) uploadFile(e.target.files[0]);
    e.target.value = "";
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
  };

  const deleteDoc = async (id) => {
    await fetch(`/api/documents/${id}`, { method: "DELETE" });
    refreshDocs();
  };

  const jumpToSource = (msgIndex, sourceNumber) => {
    const details = document.querySelector(`details[data-msg="${msgIndex}"]`);
    if (details) details.open = true;
    const chunk = document.querySelector(
      `.chunk[data-msg="${msgIndex}"][data-source-index="${sourceNumber}"]`
    );
    if (chunk) {
      chunk.scrollIntoView({ behavior: "smooth", block: "center" });
      chunk.classList.add("flash");
      setTimeout(() => chunk.classList.remove("flash"), 1200);
    }
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    if (busy) return;
    const message = input.trim();
    setInput("");
    setBusy(true);

    const docName = docs.find(d => d.id === docId)?.name || docs[0]?.name || "document";
    const label = mode === "answer" ? message
      : mode === "summarize" ? `📝 Summarize ${docName}${message ? ` — focus: ${message}` : ""}`
      : `🎯 Quiz me on ${docName}${message ? ` — focus: ${message}` : ""}`;
    setMessages(prev => [...prev, { role: "user", text: label }]);
    if (mode === "answer") historyRef.current.push({ role: "user", text: message });

    setMessages(prev => [...prev, { role: "bot", text: "", sources: null, done: false }]);
    setStatus(mode === "answer" && historyRef.current.length
      ? "Understanding the question..."
      : "Thinking...");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          mode,
          docId: docId || null,
          history: historyRef.current.slice(-8),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Request failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let answer = "";
      let sources = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message", data = "";
          for (const line of raw.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data = line.slice(6);
          }
          const payload = data ? JSON.parse(data) : {};

          if (event === "sources") {
            sources = payload;
            setStatus("");
          } else if (event === "token") {
            answer += payload.text;
            upsertLast({ text: answer, sources });
            scrollToBottom();
          } else if (event === "error") {
            throw new Error(payload.error);
          }
        }
      }

      upsertLast({ text: answer, sources, done: true });
      if (mode === "answer") historyRef.current.push({ role: "assistant", text: answer });
    } catch (err) {
      setStatus("");
      upsertLast({ done: true });
      setMessages(prev => [...prev, { role: "error", text: err.message }]);
    } finally {
      setBusy(false);
      scrollToBottom();
    }
  };

  const renderCitations = (text, sources, msgIndex) => {
    const parts = [];
    const regex = /\[Sources? ([0-9, ]+)\]/g;
    let last = 0, match, key = 0;
    const hasScores = sources?.some(s => s.score !== null);
    while ((match = regex.exec(text)) !== null) {
      if (match.index > last) parts.push(text.slice(last, match.index));
      const numbers = match[1].split(",").map(n => n.trim());
      parts.push(
        <span key={key++}>
          {numbers.map((n, i) => (
            <span
              key={i}
              className="cite"
              style={hasScores ? undefined : { cursor: "default" }}
              onClick={hasScores ? () => jumpToSource(msgIndex, n) : undefined}
            >
              {n}
            </span>
          ))}
        </span>
      );
      last = match.index + match[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  };

  const docNameOf = (doc) => {
    const ext = doc.name.split(".").pop().toUpperCase();
    return `${ext} · ${doc.pages ? doc.pages + " pages · " : ""}${doc.chunks} chunks`;
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>Doc Q&A</h1>
        <div className="subtitle">
          Upload documents (PDF, DOCX, TXT, MD) and ask questions, get summaries or
          generate quizzes. Click any citation to see the exact source text.
        </div>
        <div
          className={`upload-zone${dragging ? " dragover" : ""}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <span className="icon">📄</span>
          Click or drop a file here
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.txt,.md"
            hidden
            onChange={onFilePicked}
          />
        </div>
        <div className="doc-list">
          {docs.map(doc => (
            <div key={doc.id} className="doc-item">
              <div>
                <div className="name">{doc.name}</div>
                <div className="meta">{docNameOf(doc)}</div>
              </div>
              <button title="Remove" onClick={() => deleteDoc(doc.id)}>×</button>
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        <div className="messages" ref={messagesRef}>
          {messages.length === 0 && (
            <div className="empty-state">
              <h2>Ask your documents anything</h2>
              Upload a file on the left, then pick a mode below — Answer questions,
              Summarize a document, or generate a Quiz from it.
            </div>
          )}
          {messages.map((m, i) => {
            if (m.role === "error") return <div key={i} className="error-msg">⚠ {m.text}</div>;
            if (m.role === "user") return <div key={i} className="msg user">{m.text}</div>;
            return (
              <div key={i} className="msg bot">
                {m.text && renderCitations(m.text, m.sources, i)}
                {m.sources?.length > 0 && m.done && (
                  <div className="sources">
                    <details data-msg={i}>
                      <summary>
                        {m.sources.length} source{m.sources.length > 1 ? "s" : ""} used
                      </summary>
                      {m.sources.map((s, si) => (
                        <div
                          key={si}
                          className="chunk"
                          data-msg={i}
                          data-source-index={si + 1}
                        >
                          {`[${s.document}] chunk ${s.chunk}${s.score !== null ? ` — relevance ${s.score}` : ""}\n\n${s.text}`}
                        </div>
                      ))}
                    </details>
                  </div>
                )}
              </div>
            );
          })}
          {status && (
            <div className="typing">
              {status} <span className="spinner" />
            </div>
          )}
        </div>

        <div className="mode-bar">
          {MODES.map(m => (
            <button
              key={m.id}
              className={`mode-btn${mode === m.id ? " active" : ""}`}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
          <select
            className={`doc-select${mode !== "answer" ? " visible" : ""}`}
            value={docId}
            onChange={(e) => setDocId(e.target.value)}
          >
            <option value="">
              {docs.length === 1 ? "Auto: the only document" : "Auto: first document"}
            </option>
            {docs.map(doc => (
              <option key={doc.id} value={doc.id}>{doc.name}</option>
            ))}
          </select>
        </div>

        <form className="input-bar" onSubmit={sendMessage}>
          <input
            type="text"
            value={input}
            placeholder={PLACEHOLDERS[mode]}
            autoComplete="off"
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" disabled={busy}>Send</button>
        </form>
      </main>
    </div>
  );
}
