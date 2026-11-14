import path from "node:path";

export const SESSION_PARSER_VERSION = 4;

const INJECTED_BLOCK = /<(skill|mission-workflow-primer|system-reminder|memory-policy|project_context|available_skills)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// Free text is full of mission-like words (mission-stack, mission-execute,
// template ids like mission-a1b2), so prose only yields the short 3-char form.
// Longer ids are trusted only from structured sources: custom entries and a
// leading "Resume mission-<id>" heading.
const MISSION_TEXT_ID = /\bmission-[a-z0-9]{3}\b/gi;
const MISSION_EXACT_ID = /^mission-[a-z0-9]{3,}(?:\.\d+)*$/i;
const RESUME_HEADING = /^Resume\s+(mission-[a-z0-9.]+(?:\s*,\s*mission-[a-z0-9.]+)*)/i;
const FOCUS_ENTRY_TYPE = "land-focus";
const GENERIC_PROMPTS = /^(?:continue|resume|yes|y|ok|okay|go ahead|proceed)[.!]?$/i;

export function sanitizeText(value) {
  if (typeof value !== "string") return "";

  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\r\n?/g, "\n");
}

function stripInjectedBlocks(value) {
  return value
    .replace(INJECTED_BLOCK, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function messageText(content) {
  const raw = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n")
      : "";

  return stripInjectedBlocks(sanitizeText(raw));
}

function safeTimestamp(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function laterTimestamp(current, candidate) {
  if (!candidate) return current;
  if (!current || Date.parse(candidate) > Date.parse(current)) return candidate;
  return current;
}

function cleanTitle(value) {
  const line = sanitizeText(value).split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  const withoutHeading = line.replace(/^#{1,6}\s+/, "").trim();
  const chars = [...withoutHeading];
  return chars.length > 100 ? `${chars.slice(0, 99).join("")}…` : withoutHeading;
}

function stripLeadingAttachments(value) {
  let remaining = value.trimStart();
  while (remaining) {
    const match = remaining.match(/^(?:"((?:\\.|[^"])*)"|'([^']*)'|((?:\\.|[^\s])+))\s*/);
    if (!match) break;
    const filename = (match[1] ?? match[2] ?? match[3]).replace(/\\(.)/gs, "$1");
    if (!/^(?:\/|~\/)/.test(filename) || !/\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|pdf)$/i.test(filename)) break;
    remaining = remaining.slice(match[0].length);
  }
  return remaining;
}

function titleFromMessages(messages) {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const match = stripLeadingAttachments(message.text).match(/^Resume\s+mission-[a-z0-9]+(?:\s*,\s*mission-[a-z0-9]+)*\s*\(([^)\r\n]+)\)/i);
    if (match) return cleanTitle(match[1]);
  }

  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const line of stripLeadingAttachments(message.text).split("\n")) {
      const candidate = cleanTitle(line);
      if (candidate && !GENERIC_PROMPTS.test(candidate)) return candidate;
    }
  }

  return "Untitled session";
}

function idFromPath(sessionPath) {
  const filename = path.basename(sessionPath, path.extname(sessionPath));
  const separator = filename.lastIndexOf("_");
  return separator === -1 ? filename : filename.slice(separator + 1);
}

function addMissionIds(target, value) {
  if (typeof value !== "string") return;
  for (const match of value.matchAll(MISSION_TEXT_ID)) target.add(match[0].toLowerCase());
}

/** Epic id for a trusted mission id (child ids fold to their epic), else null. */
function exactMissionId(value) {
  if (typeof value !== "string" || !MISSION_EXACT_ID.test(value.trim())) return null;
  return value.trim().toLowerCase().split(".")[0];
}

function addExactMissionId(target, value) {
  const id = exactMissionId(value);
  if (id) target.add(id);
}

function addResumeHeadingIds(target, text) {
  const match = stripLeadingAttachments(text).match(RESUME_HEADING);
  if (!match) return;
  for (const part of match[1].split(",")) addExactMissionId(target, part.replace(/\.+$/, ""));
}

export function parseSession(text, sessionPath) {
  const warnings = [];
  const messages = [];
  const missions = new Set();
  // Ids from structured sources only (custom entries, Resume heading). The
  // sidebar groups by these; `missions` also carries prose mentions for search.
  const linked = new Set();
  let id = idFromPath(sessionPath);
  let cwd = "";
  let created = null;
  let updated = null;
  let explicitName = "";
  let model = "";
  let focus = null;

  const lines = String(text).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      warnings.push(`Could not parse line ${index + 1}: ${error.message}`);
      continue;
    }

    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`Ignored non-object entry on line ${index + 1}`);
      continue;
    }

    if (entry.type === "session") {
      if (typeof entry.id === "string" && entry.id) id = entry.id;
      if (typeof entry.cwd === "string") cwd = sanitizeText(entry.cwd);
      created = safeTimestamp(entry.timestamp) ?? created;
      continue;
    }

    if (entry.type === "session_info" && typeof entry.name === "string") {
      explicitName = cleanTitle(entry.name);
      continue;
    }

    if (entry.type === "model_change") {
      const provider = typeof entry.provider === "string" ? entry.provider : "";
      const modelId = typeof entry.modelId === "string" ? entry.modelId : "";
      if (provider && modelId) model = `${provider}/${modelId}`;
      else if (modelId) model = modelId;
      continue;
    }

    if (entry.type === "custom") {
      addExactMissionId(linked, entry.data?.id);
      if (Array.isArray(entry.data?.missionIds)) {
        for (const missionId of entry.data.missionIds) addExactMissionId(linked, missionId);
      }
      if (entry.customType === FOCUS_ENTRY_TYPE) focus = exactMissionId(entry.data?.id);
      continue;
    }

    if (entry.type !== "message") continue;

    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;

    const cleaned = messageText(entry.message?.content);
    if (!cleaned) continue;

    const timestamp = safeTimestamp(entry.timestamp) ?? safeTimestamp(entry.message?.timestamp);
    messages.push({ role, text: cleaned, timestamp });
    updated = laterTimestamp(updated, timestamp);
    addMissionIds(missions, cleaned);
    if (role === "user") addResumeHeadingIds(linked, cleaned);

    const provider = typeof entry.message?.provider === "string" ? entry.message.provider : "";
    const modelId = typeof entry.message?.model === "string" ? entry.message.model : "";
    if (provider && modelId) model = `${provider}/${modelId}`;
  }

  const title = explicitName || titleFromMessages(messages);
  const normalizedPath = path.resolve(sessionPath);

  return {
    id,
    path: normalizedPath,
    cwd,
    title,
    model,
    missions: [...new Set([...linked, ...missions])],
    linked: [...linked],
    focus,
    updated: updated ?? created,
    messages,
    subagent: /^subagent(?:\b|[-_:])/i.test(title) || /\/(?:subagents|forks)\//i.test(normalizedPath),
    warnings,
  };
}
