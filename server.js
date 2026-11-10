import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = process.env.PORT || 3001;

if (!process.env.GEMINI_API_KEY) {
  console.warn(
    "WARNING: GEMINI_API_KEY is not set. Copy .env.example to .env and add your key from https://aistudio.google.com/apikey",
  );
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const EMBED_MODEL = "gemini-embedding-001";
const CHAT_MODEL = "gemini-3.5-flash";
const REWRITE_MODEL = "gemini-3.1-flash-lite";

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 200;
const TOP_K = 4;
const MAX_HISTORY = 8;
const LOW_TEXT_THRESHOLD = 20;
const MAX_FULL_DOC_CHUNKS = 30;

mkdirSync("data", { recursive: true });
const db = new DatabaseSync("data/rag.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    pages INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
`);

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.split(".").pop().toLowerCase();
    if (["pdf", "docx", "txt", "md"].includes(ext)) cb(null, true);
    else cb(new Error("Only PDF, DOCX, TXT or MD files are allowed"));
  },
});

app.use(express.json());

async function extractText(file, buffer) {
  const ext = file.originalname.split(".").pop().toLowerCase();
  if (ext === "pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = await pdfParse(buffer);
    return { text: parsed.text, pages: parsed.numpages };
  }
  if (ext === "docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer });
    return { text: value, pages: null };
  }
  return { text: buffer.toString("utf8"), pages: null };
}

function chunkText(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end).replace(/\s+/g, " ").trim());
    if (end === text.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks.filter((c) => c.length > 0);
}

async function embedBatch(texts, taskType) {
  const response = await ai.models.embedContent({
    model: EMBED_MODEL,
    contents: texts,
    config: { taskType },
  });
  return response.embeddings.map((e) => e.values);
}

function toBlob(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}
function fromBlob(buf) {
  return Array.from(
    new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
  );
}

function cosineSimilarity(a, b) {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function search(questionEmbedding, k = TOP_K) {
  const rows = db
    .prepare(
      `
    SELECT d.name AS docName, c.idx, c.text, c.embedding
    FROM chunks c JOIN documents d ON d.id = c.doc_id
  `,
    )
    .all();
  return rows
    .map((r) => ({
      docName: r.docName,
      index: r.idx,
      text: r.text,
      score: cosineSimilarity(questionEmbedding, fromBlob(r.embedding)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

async function ocrPdf(buffer) {
  const response = await ai.models.generateContent({
    model: CHAT_MODEL,
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: "application/pdf",
              data: buffer.toString("base64"),
            },
          },
          {
            text: "Transcribe ALL text content from this PDF, in reading order. Output only the transcribed text with no commentary.",
          },
        ],
      },
    ],
  });
  return response.text;
}

async function rewriteQuery(message, history) {
  const transcript = history
    .slice(-MAX_HISTORY)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n");
  try {
    const response = await ai.models.generateContent({
      model: REWRITE_MODEL,
      contents: `Rewrite the user's follow-up question as a single standalone search query that can be understood without the conversation context. Keep the original language. Reply with ONLY the rewritten query, nothing else.

Conversation:
${transcript}

Follow-up question: ${message}

Standalone query:`,
    });
    const rewritten = response.text?.trim();
    return rewritten || message;
  } catch {
    return message;
  }
}

function getDocChunks(docId) {
  const doc = db
    .prepare("SELECT id, name FROM documents WHERE id = ?")
    .get(docId);
  if (!doc) return null;
  const chunks = db
    .prepare("SELECT idx, text FROM chunks WHERE doc_id = ? ORDER BY idx")
    .all(docId);
  return { doc, chunks };
}

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    if (!process.env.GEMINI_API_KEY) {
      return res
        .status(500)
        .json({ error: "GEMINI_API_KEY is not configured" });
    }

    const buffer = await fs.readFile(req.file.path);
    await fs.unlink(req.file.path);

    const ext = req.file.originalname.split(".").pop().toLowerCase();
    let { text, pages } = await extractText(req.file, buffer);
    let ocrUsed = false;

    if (text.trim().length < LOW_TEXT_THRESHOLD) {
      if (ext !== "pdf") {
        return res
          .status(400)
          .json({ error: "No extractable text found in this file" });
      }
      console.log(`Little/no text found in PDF, falling back to OCR...`);
      text = await ocrPdf(buffer);
      ocrUsed = true;
      if (!text.trim()) {
        return res
          .status(400)
          .json({
            error:
              "Could not extract any text, even with OCR — the PDF may be empty or unreadable",
          });
      }
    }

    const chunks = chunkText(text);
    const embeddings = await embedBatch(chunks, "RETRIEVAL_DOCUMENT");

    const id = crypto.randomUUID();
    const name = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    const type = req.file.mimetype;

    db.prepare(
      "INSERT INTO documents (id, name, type, pages) VALUES (?, ?, ?, ?)",
    ).run(id, name, type, pages);
    const insertChunk = db.prepare(
      "INSERT INTO chunks (doc_id, idx, text, embedding) VALUES (?, ?, ?, ?)",
    );
    for (let i = 0; i < chunks.length; i++) {
      insertChunk.run(id, i, chunks[i], toBlob(embeddings[i]));
    }

    console.log(
      `Indexed "${name}": ${chunks.length} chunks${pages ? ` from ${pages} pages` : ""}${ocrUsed ? " (via OCR)" : ""}`,
    );
    res.json({ id, name, type, pages, chunks: chunks.length, ocr: ocrUsed });
  } catch (err) {
    console.error("Upload failed:", err.message);
    res.status(500).json({ error: "Failed to process file: " + err.message });
  }
});

app.get("/api/documents", (_req, res) => {
  const docs = db
    .prepare(
      `
    SELECT d.id, d.name, d.type, d.pages, COUNT(c.id) AS chunks
    FROM documents d LEFT JOIN chunks c ON c.doc_id = d.id
    GROUP BY d.id ORDER BY d.created_at
  `,
    )
    .all();
  res.json(docs);
});

app.delete("/api/documents/:id", (req, res) => {
  const doc = db
    .prepare("SELECT id FROM documents WHERE id = ?")
    .get(req.params.id);
  if (!doc) return res.status(404).json({ error: "Document not found" });
  db.prepare("DELETE FROM chunks WHERE doc_id = ?").run(req.params.id);
  db.prepare("DELETE FROM documents WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  const {
    message = "",
    history = [],
    mode = "answer",
    docId = null,
  } = req.body;
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not configured" });
  }

  const docCount = db.prepare("SELECT COUNT(*) AS n FROM documents").get().n;
  if (docCount === 0) {
    return res
      .status(400)
      .json({ error: "Upload a document first, then ask questions about it" });
  }

  let buildPrompt;
  if (mode === "answer") {
    if (!message.trim())
      return res.status(400).json({ error: "Message is required" });
    buildPrompt = async () => {
      const searchQuery = history.length
        ? await rewriteQuery(message.trim(), history)
        : message.trim();
      const [questionEmbedding] = await embedBatch(
        [searchQuery],
        "RETRIEVAL_QUERY",
      );
      const hits = search(questionEmbedding);

      const transcript = (Array.isArray(history) ? history : [])
        .slice(-MAX_HISTORY)
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
        .join("\n");

      const context = hits
        .map(
          (h, i) =>
            `[Source ${i + 1} — ${h.docName}, chunk ${h.index + 1}]\n${h.text}`,
        )
        .join("\n\n---\n\n");

      const prompt = `You are a helpful assistant that answers questions strictly based on the provided document excerpts.

Rules:
- Answer only from the context below. If the answer is not in the context, say "I couldn't find that in the uploaded documents."
- Use the conversation history to resolve references like "it", "that", or follow-up questions.
- Cite the sources you used, like [Source 1] or [Source 2, 3].
- Be concise and direct.

${transcript ? `Conversation history:\n${transcript}\n` : ""}
Context:
${context}

Question: ${message.trim()}

Answer:`;

      return {
        prompt,
        sources: hits.map((h) => ({
          document: h.docName,
          chunk: h.index + 1,
          score: Number(h.score.toFixed(4)),
          text: h.text,
        })),
      };
    };
  } else if (mode === "summarize" || mode === "quiz") {
    let targetId = docId;
    if (!targetId && docCount === 1) {
      targetId = db.prepare("SELECT id FROM documents LIMIT 1").get().id;
    }
    const docData = targetId ? getDocChunks(targetId) : null;
    if (!docData) {
      return res.status(400).json({ error: "Select a document for this mode" });
    }

    buildPrompt = async () => {
      const capped = docData.chunks.slice(0, MAX_FULL_DOC_CHUNKS);
      const context = capped
        .map(
          (c, i) =>
            `[Source ${i + 1} — ${docData.doc.name}, chunk ${c.idx + 1}]\n${c.text}`,
        )
        .join("\n\n---\n\n");

      const focus = message.trim()
        ? `\nAdditional focus from the user: "${message.trim()}"`
        : "";
      const task =
        mode === "summarize"
          ? `Write a clear, structured summary of this document using headings and bullet points.${focus}`
          : `Create a quiz of 5 questions based strictly on this document. Mix question types (factual, comprehension). Number each question, and after all questions, list the answers with brief explanations.${focus}`;

      const prompt = `${task}

Rules:
- Use only the content below.
- Cite the sources you used, like [Source 1] or [Source 2, 3].

Context:
${context}`;

      return {
        prompt,
        sources: capped.map((c) => ({
          document: docData.doc.name,
          chunk: c.idx + 1,
          score: null,
          text: c.text,
        })),
      };
    };
  } else {
    return res
      .status(400)
      .json({ error: "Unknown mode. Use answer, summarize or quiz" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const { prompt, sources } = await buildPrompt();
    send("sources", sources);

    const stream = await ai.models.generateContentStream({
      model: CHAT_MODEL,
      contents: prompt,
    });

    for await (const chunk of stream) {
      if (chunk.text) send("token", { text: chunk.text });
    }
    send("done", {});
  } catch (err) {
    console.error("Chat failed:", err.message);
    send("error", { error: "Failed to answer: " + err.message });
  }
  res.end();
});

app.use((err, _req, res, _next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "File too large (max 20 MB)" });
  }
  res.status(400).json({ error: err.message });
});

async function main() {
  await fs.mkdir("uploads", { recursive: true }).catch(() => {});
  await fs.mkdir("data", { recursive: true }).catch(() => {});
  app.listen(PORT, () => {
    console.log(`RAG Document Q&A running at http://localhost:${PORT}`);
  });
}

main();
