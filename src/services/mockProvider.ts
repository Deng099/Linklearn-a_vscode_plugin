import type { ConceptJson, OutputLanguage } from "./aiService";
import type { AiProvider } from "./aiProvider";

export class MockProvider implements AiProvider {
  async generateConcept(term: string, _contextHint?: string, _outputLanguage?: OutputLanguage): Promise<ConceptJson> {
    return {
      term,
      one_liner_en: `${term} is a mocked concept for development.`,
      one_liner_zh: `${term} 是用于开发测试的模拟概念。`,
      detail_en:
        "This is mock detail text used for local development without network or API consumption.",
      detail_zh: "这是用于本地开发的模拟详细说明，不消耗 API 且不依赖网络。",
      key_points_en: ["Point A", "Point B", "Point C"],
      key_points_zh: ["要点A", "要点B", "要点C"],
      misconceptions_en: ["Mock misunderstanding"],
      misconceptions_zh: ["模拟常见误区"],
      follow_ups: ["next concept"],
    };
  }

  async answerConceptQuestion(): Promise<string> {
    return "这是 mock 回答。";
  }

  async renderConceptNarrative(concept: ConceptJson, outputLanguage: OutputLanguage): Promise<string> {
    if (outputLanguage === "en") {
      return `${concept.term} can be understood as: ${concept.one_liner_en ?? ""} ${concept.detail_en ?? ""}`.trim();
    }

    if (outputLanguage === "bilingual") {
      return [
        `${concept.term} can be understood as: ${concept.one_liner_en ?? ""} ${concept.detail_en ?? ""}`.trim(),
        `${concept.term}可以理解为：${concept.one_liner_zh ?? ""} ${concept.detail_zh ?? ""}`.trim(),
      ].join("\n\n");
    }

    return `${concept.term}可以理解为：${concept.one_liner_zh ?? ""} ${concept.detail_zh ?? ""}`.trim();
  }
}
