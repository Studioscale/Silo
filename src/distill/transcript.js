/**
 * Read an OpenClaw session transcript (.jsonl) and extract the user+assistant
 * dialogue lines worth sending to the LLM. Tool output, system metadata,
 * timestamps, and slash-commands are filtered out.
 *
 * This mirrors Jarvis's session-extract noise-filter so the Silo pipeline
 * produces comparable transcripts during cutover.
 */

import { promises as fs } from 'node:fs';

const MAX_MESSAGE_LEN = 2000;
const TOKEN_PER_WORD = 0.75;

/**
 * @param {string} filePath  Absolute path to a `.jsonl` transcript file
 * @param {number} [lastProcessedLine]  Skip the first N lines (for delta reads)
 * @returns {Promise<{messages: Array<{role,text}>, totalLines: number, dialogueTokenEstimate: number}>}
 */
export async function readSessionDelta(filePath, lastProcessedLine = 0) {
  const raw = await fs.readFile(filePath, 'utf8');
  return parseSessionDelta(raw, lastProcessedLine);
}

/**
 * Pure-function variant that accepts the raw transcript string. Useful for
 * tests that want to avoid touching the filesystem.
 */
export function parseSessionDelta(rawText, lastProcessedLine = 0) {
  const content = (rawText ?? '').trim();
  if (!content) return { messages: [], totalLines: 0, dialogueTokenEstimate: 0 };

  const lines = content.split('\n');
  const totalLines = lines.length;
  const newLines = lines.slice(lastProcessedLine);

  const messages = [];
  for (const line of newLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'message' || !entry.message) continue;
      const msg = entry.message;
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;

      let text = '';
      if (Array.isArray(msg.content)) {
        const textPart = msg.content.find((c) => c.type === 'text');
        text = textPart?.text ?? '';
      } else {
        text = String(msg.content ?? '');
      }
      if (!text) continue;

      // Filter: slash commands, tool blobs, XML/system envelopes, ISO-timestamp pings
      if (text.startsWith('/')) continue;
      if (text.startsWith('<tool_call>') || text.startsWith('<?xml') || text.startsWith('<')) continue;
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) && text.length < 30) continue;
      if (text.includes('<tool_result>') || text.includes('</tool_result>')) continue;
      if (text.startsWith('System:') || text.startsWith('[system]')) continue;

      const trimmed =
        text.length > MAX_MESSAGE_LEN ? text.slice(0, MAX_MESSAGE_LEN) + '...[truncated]' : text;
      messages.push({ role: msg.role, text: trimmed });
    } catch {
      // malformed JSON line — ignore
    }
  }

  const wordCount = messages.reduce((n, m) => n + m.text.split(/\s+/).filter(Boolean).length, 0);
  const dialogueTokenEstimate = Math.round(wordCount * TOKEN_PER_WORD);

  return { messages, totalLines, dialogueTokenEstimate };
}

/**
 * Flatten messages into the string body sent to the LLM.
 */
export function transcriptBody(messages) {
  return messages.map((m) => `${m.role}: ${m.text}`).join('\n\n');
}
