import type { ConceptJson, OutputLanguage } from "./aiService";

export interface AiProvider {
  generateConcept(term: string, contextHint?: string, outputLanguage?: OutputLanguage): Promise<ConceptJson>;
  answerConceptQuestion(term: string, question: string, conceptBody?: string): Promise<string>;
  renderConceptNarrative?(concept: ConceptJson, outputLanguage: OutputLanguage): Promise<string>;
}
