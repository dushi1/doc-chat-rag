# Doc Q&A — AI Document Chatbot (RAG)

Upload documents (PDF, DOCX, TXT, MD) and ask questions about them. Answers
stream in token-by-token and come from a Gemini-powered retrieval-augmented
generation (RAG) pipeline with citations.

**Stack:** Next.js frontend (`web/`) + Express API (`server.js`). The Next.js
dev server proxies `/api/*` to Express, so everything runs on one URL.

## How it works

1. **Upload** — text is extracted (`pdf-parse` for PDF, `mammoth` for DOCX),
   split into overlapping chunks (1200 chars / 200 overlap), and embedded with
   `gemini-embedding-001`.
2. **Index** — chunks + embeddings are stored in SQLite (`node:sqlite`,
   zero-dependency); the index survives server restarts.
3. **Query** — your question is embedded (`RETRIEVAL_QUERY`), the top 4 chunks
   across all documents are found by cosine similarity, and Gemini
   (`gemini-3.5-flash`) answers strictly from that context with `[Source N]`
   citations.
4. **Stream** — answers stream to the browser via Server-Sent Events; the
   last 8 conversation turns are sent as context so follow-up questions like
   "what about sick leave?" work naturally. With history present, a fast
   model first rewrites the follow-up into a standalone search query before
   retrieval.
5. **Modes** — Answer (grounded RAG Q&A), Summarize (whole-document summary),
   and Quiz (generate 5 questions + answers), selectable in the UI with an
   optional focus instruction.
6. **OCR fallback** — if a PDF has no extractable text layer (scanned pages),
   the file is sent to Gemini vision for transcription before indexing.
7. **Clickable citations** — `[Source N]` markers in answers are clickable
   and jump to the exact source chunk text.

## Setup

```bash
cd rag-doc-qa
npm install          # Express API + concurrently
npm run web:install  # Next.js frontend (first time only; or: cd web && npm install)
cp .env.example .env # add your Gemini API key from https://aistudio.google.com/apikey
npm run dev          # runs API (port 3001) + Next.js (port 3000) together
```

Open http://localhost:3000, drop in a document, and ask questions.
`npm run server` runs the API alone; `npm run web:build && npm start` runs a
production build of the frontend.

## API

| Method | Route                | Description                     |
|--------|----------------------|---------------------------------|
| POST   | `/api/upload`        | Upload PDF/DOCX/TXT/MD (multipart `file`) |
| GET    | `/api/documents`     | List indexed documents          |
| DELETE | `/api/documents/:id` | Remove a document               |
| POST   | `/api/chat`          | `{ "message?", "mode": "answer"\|"summarize"\|"quiz", "docId?", "history?" }` → SSE: `sources`, `token`, `done` |
