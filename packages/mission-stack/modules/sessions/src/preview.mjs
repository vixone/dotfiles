import path from "node:path";

import { sanitizeText } from "./session.mjs";

function clean(value) {
  return sanitizeText(String(value ?? "")).trim();
}

function compactTimestamp(value) {
  if (!value || Number.isNaN(Date.parse(value))) return "unknown time";
  return value.replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, "Z");
}

function queryTerms(query) {
  return clean(query)
    .split(/\s+/)
    .map((term) => term.replace(/^[!'|^]+|[$|]+$/g, ""))
    .filter(Boolean);
}

function matchPosition(text, query) {
  const lower = text.toLowerCase();
  const exact = clean(query).toLowerCase();
  if (exact) {
    const exactIndex = lower.indexOf(exact);
    if (exactIndex !== -1) return exactIndex;
  }
  for (const term of queryTerms(query)) {
    const index = lower.indexOf(term.toLowerCase());
    if (index !== -1) return index;
  }
  return -1;
}

function clipped(text, position = 0, limit = 1_000) {
  const value = clean(text);
  if (value.length <= limit) return value;
  const start = Math.max(0, Math.min(position - 350, value.length - limit));
  const end = Math.min(value.length, start + limit);
  return `${start > 0 ? "…" : ""}${value.slice(start, end).trim()}${end < value.length ? "…" : ""}`;
}

function messageBlock(message, text = message.text) {
  const label = message.role === "user" ? "USER" : "ASSISTANT";
  return `[${label} · ${compactTimestamp(message.timestamp)}]\n${text}`;
}

export function formatPreview(session, query = "") {
  if (!session) return "Session not found.";
  const metadata = [
    clean(session.title) || "Untitled session",
    clean(session.cwd),
    `Session  ${clean(session.id)}`,
    session.missions?.length ? `Mission  ${session.missions.map(clean).join(", ")}` : null,
    session.model ? `Model    ${clean(session.model)}` : null,
    `Active   ${compactTimestamp(session.updated)}`,
    `File     ${path.basename(clean(session.path))}`,
  ].filter(Boolean);

  const sections = [metadata.join("\n")];
  let matchedIndex = -1;
  let matchedPosition = -1;
  if (query) {
    matchedIndex = session.messages.findIndex((message) => {
      matchedPosition = matchPosition(message.text, query);
      return matchedPosition !== -1;
    });
  }
  if (matchedIndex !== -1) {
    sections.push(`Matching excerpt\n${messageBlock(
      session.messages[matchedIndex],
      clipped(session.messages[matchedIndex].text, matchedPosition),
    )}`);
  }

  const latest = session.messages
    .map((message, index) => ({ message, index }))
    .filter(({ index }) => index !== matchedIndex)
    .slice(-2)
    .map(({ message }) => messageBlock(message, clipped(message.text, 0, 700)));
  if (latest.length) sections.push(`Latest conversation\n${latest.join("\n\n")}`);
  if (session.warnings?.length) sections.push(`Parser warnings  ${session.warnings.length}`);
  return `${sections.join("\n\n")}\n`;
}
