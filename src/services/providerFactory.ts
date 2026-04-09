import * as vscode from "vscode";
import { AiService } from "./aiService";
import type { AiProvider } from "./aiProvider";
import { MockProvider } from "./mockProvider";

export function createProvider(): AiProvider {
  const cfg = vscode.workspace.getConfiguration("linklearn");
  const provider = String(cfg.get("ai.provider") ?? "openai").trim().toLowerCase();

  if (provider === "mock") {
    return new MockProvider();
  }

  return AiService.fromVSCodeConfig();
}
