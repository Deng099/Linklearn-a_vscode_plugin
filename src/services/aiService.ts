/* aiService.ts
 * LinkLearn - AI generation service
 * Strategy:
 * 1) Force model output to STRICT JSON (no markdown, no "Answer:", no extra text).
 * 2) Parse JSON robustly (strip code fences, extract first JSON object if mixed).
 * 3) Validate schema; retry if invalid.
 */

import * as vscode from "vscode";
import type { AiProvider } from "./aiProvider";

export type ConceptJson = {
  term: string;
  one_liner_en?: string;
  one_liner_zh?: string;
  detail_en?: string;
  detail_zh?: string;
  key_points_en?: string[];
  key_points_zh?: string[];
  misconceptions_en?: string[];
  misconceptions_zh?: string[];
  follow_ups?: string[];
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

function isChatCompletionResponse(x: unknown): x is ChatCompletionResponse {
  if (typeof x !== "object" || x === null) return false;
  return "choices" in x;
}

type AiConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  debug: boolean;
  narrativeSystemPrompt: string;
  narrativeUserPromptTemplate: string;
};

export type OutputLanguage = "zh" | "en" | "bilingual";
export const LANGUAGE_OPTIONS = ["zh", "en", "bilingual"] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function stripCodeFences(s: string): string {
  return s.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") depth--;

    if (depth === 0) return text.slice(start, i + 1);
  }

  return null;
}

function ensureString(x: unknown, field: string): string {
  if (typeof x !== "string" || x.trim().length === 0) {
    throw new Error(`Invalid field "${field}": expected non-empty string.`);
  }
  return x.trim();
}

function ensureStringArray(x: unknown, field: string): string[] | undefined {
  if (x === undefined) return undefined;
  if (!Array.isArray(x)) throw new Error(`Invalid field "${field}": expected string[].`);

  const arr: string[] = [];
  for (const v of x) {
    if (typeof v !== "string") throw new Error(`Invalid field "${field}": expected string[].`);
    const t = v.trim();
    if (t) arr.push(t);
  }

  return arr;
}

function validateConceptJson(raw: unknown, expectedTerm: string, outputLanguage: OutputLanguage): ConceptJson {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const term = ensureString(obj.term, "term");

  if (term !== expectedTerm) {
    throw new Error(`Term mismatch: expected "${expectedTerm}", got "${term}".`);
  }

  const concept: ConceptJson = {
    term,
    key_points_en: ensureStringArray(obj.key_points_en, "key_points_en"),
    key_points_zh: ensureStringArray(obj.key_points_zh, "key_points_zh"),
    misconceptions_en: ensureStringArray(obj.misconceptions_en, "misconceptions_en"),
    misconceptions_zh: ensureStringArray(obj.misconceptions_zh, "misconceptions_zh"),
    follow_ups: ensureStringArray(obj.follow_ups, "follow_ups"),
  };

  if (outputLanguage === "zh" || outputLanguage === "bilingual") {
    concept.one_liner_zh = ensureString(obj.one_liner_zh, "one_liner_zh");
    concept.detail_zh = ensureString(obj.detail_zh, "detail_zh");
  }

  if (outputLanguage === "en" || outputLanguage === "bilingual") {
    concept.one_liner_en = ensureString(obj.one_liner_en, "one_liner_en");
    concept.detail_en = ensureString(obj.detail_en, "detail_en");
  }

  if (outputLanguage === "zh") {
    if (obj.one_liner_en !== undefined || obj.detail_en !== undefined || obj.key_points_en !== undefined || obj.misconceptions_en !== undefined) {
      throw new Error("English fields are not allowed in zh mode.");
    }
  }

  if (outputLanguage === "en") {
    if (obj.one_liner_zh !== undefined || obj.detail_zh !== undefined || obj.key_points_zh !== undefined || obj.misconceptions_zh !== undefined) {
      throw new Error("Chinese fields are not allowed in en mode.");
    }
  }

  return concept;
}

function buildPrompt(term: string, outputLanguage: OutputLanguage, contextHint?: string): { system: string; user: string } {
  const system = [
    "You are an assistant that returns STRICT JSON only.",
    'Do NOT output Markdown, code fences, or any prefix like "Answer:" / "Final:" / "Assistant:".',
    "Return a single JSON object and nothing else.",
    "All fields must be present even if short.",
    "Use plain text (no Markdown) inside values.",
  ].join("\n");

  const schema: Record<string, unknown> = {
    term,
    follow_ups: ["string"],
  };

  if (outputLanguage === "zh" || outputLanguage === "bilingual") {
    schema.one_liner_zh = "string";
    schema.detail_zh = "string";
    schema.key_points_zh = ["string"];
    schema.misconceptions_zh = ["string"];
  }

  if (outputLanguage === "en" || outputLanguage === "bilingual") {
    schema.one_liner_en = "string";
    schema.detail_en = "string";
    schema.key_points_en = ["string"];
    schema.misconceptions_en = ["string"];
  }

  const user = [
    `Term: ${term}`,
    contextHint ? `Context (optional, may help disambiguation): ${contextHint}` : "",
    "",
    "Task:",
    "1) Follow the selected language setting exactly.",
    outputLanguage === "bilingual"
      ? "2) Provide both English and Chinese one-liner + detailed explanation + key points + misconceptions."
      : outputLanguage === "zh"
        ? "2) Provide Chinese one-liner + detailed explanation + key points + misconceptions only."
        : "2) Provide English one-liner + detailed explanation + key points + misconceptions only.",
    "3) Provide up to 5 follow-up terms (as strings) that are natural next questions.",
    "",
    "Output MUST be STRICT JSON matching this shape (values are examples of types):",
    JSON.stringify(schema, null, 2),
  ].filter(Boolean).join("\n");

  return { system, user };
}

function buildNarrativePrompt(
  concept: ConceptJson,
  outputLanguage: OutputLanguage,
  customSystemPrompt?: string,
  customUserPromptTemplate?: string
): { system: string; user: string } {
  let defaultSystem: string;
  if (outputLanguage === "en") {
    defaultSystem = [
      "You are a teacher who explains abstract concepts clearly in natural English.",
      "Return plain text only.",
      "Do NOT output Markdown headings, lists, code blocks, or prefixes like 'Answer:'.",
    ].join("\n");
  } else if (outputLanguage === "zh") {
    defaultSystem = [
      "你是一个擅长把抽象概念讲清楚的中文老师。",
      "请输出纯文本，不要使用 Markdown 标题、列表、代码块或前缀（如 Answer:）。",
    ].join("\n");
  } else {
    defaultSystem = [
      "You are a bilingual teacher explaining concepts clearly in both English and Chinese.",
      "Return plain text only.",
      "No Markdown headings or prefixes.",
    ].join("\n");
  }

  const defaultUserTemplate = outputLanguage === "en"
    ? [
      "Goal: Rewrite the structured concept into a natural English explanation.",
      "Structure:",
      "1) Start with a one-sentence definition.",
      "2) Expand in 2-3 paragraphs covering mechanism, key points and misconceptions.",
      "Do not add new facts.",
      "",
      "Concept JSON:",
      "${conceptJson}",
    ].join("\n")
    : outputLanguage === "zh"
      ? [
        "目标：把结构化概念改写成更自然的中文讲解。",
        "结构：",
        "1）先用一句话回答“它是什么”。",
        "2）再用 2-3 段展开，覆盖核心机制、关键要点和常见误区。",
        "严禁添加 JSON 中没有的新事实。",
        "",
        "概念 JSON：",
        "${conceptJson}",
      ].join("\n")
      : [
        "Goal: Provide a bilingual explanation (English first, then Chinese).",
        "Keep both languages consistent.",
        "Do not add new facts.",
        "",
        "Concept JSON:",
        "${conceptJson}",
      ].join("\n");

  const system = customSystemPrompt?.trim() || defaultSystem;
  const userTemplate = customUserPromptTemplate?.trim() || defaultUserTemplate;
  const conceptJson = JSON.stringify(concept, null, 2);
  const user = userTemplate.replace(/\$\{conceptJson\}/g, conceptJson);

  return { system, user };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

export class AiService implements AiProvider {
  private readonly cfg: AiConfig;

  constructor(cfg: AiConfig) {
    this.cfg = cfg;
  }

  static fromVSCodeConfig(): AiService {
    const cfg = vscode.workspace.getConfiguration("linklearn");
    const baseUrl = String(cfg.get("ai.baseUrl") ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const apiKey = String(cfg.get("ai.apiKey") ?? "").trim();
    const model = String(cfg.get("ai.model") ?? "gpt-4o-mini").trim();
    const timeoutMs = Number(cfg.get("ai.timeoutMs") ?? 45_000);
    const maxRetries = Number(cfg.get("ai.maxRetries") ?? 2);
    const debug = Boolean(cfg.get("ai.debug") ?? false);
    const narrativeSystemPrompt = String(cfg.get("ai.narrativeSystemPrompt") ?? "").trim();
    const narrativeUserPromptTemplate = String(cfg.get("ai.narrativeUserPromptTemplate") ?? "").trim();

    if (!apiKey) {
      throw new Error('Missing API key. Set "linklearn.ai.apiKey" in VSCode settings (User or Workspace).');
    }

    return new AiService({
      baseUrl,
      apiKey,
      model,
      timeoutMs,
      maxRetries,
      debug,
      narrativeSystemPrompt,
      narrativeUserPromptTemplate,
    });
  }

  async generateConcept(term: string, contextHint?: string, outputLanguage: OutputLanguage = "bilingual"): Promise<ConceptJson> {
    const { system, user } = buildPrompt(term, outputLanguage, contextHint);
    const url = `${this.cfg.baseUrl}/chat/completions`;
    const body = {
      model: this.cfg.model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    };

    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        if (this.cfg.debug) console.log("[LinkLearn] AI request body:", body);

        const res = await fetchWithTimeout(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body: JSON.stringify(body),
        }, this.cfg.timeoutMs);

        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          throw new Error(`AI HTTP ${res.status}: ${txt.slice(0, 300)}`);
        }

        const dataUnknown: unknown = await res.json();
        if (!isChatCompletionResponse(dataUnknown)) throw new Error("AI response shape invalid: missing choices");

        const content = dataUnknown.choices?.[0]?.message?.content;
        if (!content || typeof content !== "string") throw new Error("AI response missing choices[0].message.content");

        const cleaned = stripCodeFences(content);
        let parsed: unknown;
        try {
          parsed = JSON.parse(cleaned);
        } catch {
          const extracted = extractFirstJsonObject(cleaned);
          if (!extracted) throw new Error("Failed to extract JSON object from model output.");
          parsed = JSON.parse(extracted);
        }

        return validateConceptJson(parsed, term, outputLanguage);
      } catch (e) {
        lastErr = e;
        if (attempt < this.cfg.maxRetries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async answerConceptQuestion(term: string, question: string, conceptBody?: string): Promise<string> {
    const url = `${this.cfg.baseUrl}/chat/completions`;
    const body = {
      model: this.cfg.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: [
            "You answer questions about a concept.",
            "Return plain text only.",
            'Do NOT output Markdown headings, code fences, or prefixes like "Answer:".',
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Concept: ${term}`,
            conceptBody ? `Known concept notes:\n${conceptBody}` : "",
            `Question: ${question}`,
            "Please answer in Chinese, concise but clear.",
          ].filter(Boolean).join("\n\n"),
        },
      ],
    };

    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    }, this.cfg.timeoutMs);

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`AI HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }

    const dataUnknown: unknown = await res.json();
    if (!isChatCompletionResponse(dataUnknown)) throw new Error("AI response shape invalid: missing choices");

    const content = dataUnknown.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") throw new Error("AI response missing choices[0].message.content");

    return content.replace(/^\s*\*\*?Answer:\*\*?\s*/i, "").replace(/^\s*Answer:\s*/i, "").trim();
  }

  async renderConceptNarrative(concept: ConceptJson, outputLanguage: OutputLanguage): Promise<string> {
    const { system, user } = buildNarrativePrompt(
      concept,
      outputLanguage,
      this.cfg.narrativeSystemPrompt,
      this.cfg.narrativeUserPromptTemplate
    );
    const url = `${this.cfg.baseUrl}/chat/completions`;
    const body = {
      model: this.cfg.model,
      temperature: 0.4,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };

    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    }, this.cfg.timeoutMs);

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`AI HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }

    const dataUnknown: unknown = await res.json();
    if (!isChatCompletionResponse(dataUnknown)) throw new Error("AI response shape invalid: missing choices");

    const content = dataUnknown.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") throw new Error("AI response missing choices[0].message.content");

    return content.replace(/^\s*\*\*?Answer:\*\*?\s*/i, "").replace(/^\s*Answer:\s*/i, "").trim();
  }
}
