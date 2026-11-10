import "./globals.css";

export const metadata = {
  title: "Doc Q&A — AI Assistant",
  description:
    "Upload documents and chat with them. RAG pipeline with Gemini, citations, summaries and quiz modes.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
