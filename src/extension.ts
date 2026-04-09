import * as vscode from "vscode";
import { LANGUAGE_OPTIONS, type ConceptJson, type OutputLanguage } from "./services/aiService";
import { createProvider } from "./services/providerFactory";

/**
 * LinkLearn - extension.ts (完整可运行版本)
 *
 * 能力：
 * 1) Markdown 中识别 [[term]]
 * 2) Hover 显示“一句话解释：...”
 * 3) Hover 中提供：
 *    - 打开 concept 文件
 *    - 编辑“一句话解释”
 * 4) concept 文件路径：
 *    <workspace>/.linklearn/concepts/<term>.md
 * 5) 自动创建目录/文件
 * 6) 缓存 + watcher：减少重复读文件，文件改了自动失效缓存
 *
 */

const CONCEPT_DIR = [".linklearn", "concepts"] as const;

// ====== 工具函数 ======

function sanitizeFileName(name: string): string {
  // 把不适合做文件名的字符替换掉
  // Windows / macOS / Linux 都尽量安全
  return name
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

/** 从 "[[term]]" 提取 term */
function extractTermFromBrackets(text: string): string | null {
  const m = text.match(/^\[\[([^\]]+)\]\]$/);
  return m ? m[1].trim() : null;
}

/** 解析 concept 文件中的“一句话解释：xxx” */
function parseOneLineExplain(fileText: string): string | null {
  // 兼容老模板：一句话解释：xxx
  const classic = fileText.match(/^\s*一句话解释\s*[:：]\s*(.*)\s*$/m);
  if (classic) {
    return (classic[1] ?? "").trim();
  }

  // 兼容新模板：## 一句话解释 后第一行引用
  const lines = fileText.split(/\r?\n/);
  const headingIdx = lines.findIndex((line) => /^\s*##\s+一句话解释\s*$/.test(line));
  if (headingIdx >= 0) {
    for (let i = headingIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (/^##\s+/.test(line)) break;
      if (line.startsWith(">")) {
        return line.replace(/^>\s*/, "").trim();
      }
      break;
    }
  }

  return null;
}

/** 把“一句话解释：...” 更新为新值；如果没有这一行，就插到文件顶部 */
function upsertOneLineExplain(fileText: string, newValue: string): string {
  const lines = fileText.split(/\r?\n/);
  const sectionIdx = lines.findIndex((l) => /^\s*##\s+一句话解释\s*$/.test(l));

  if (sectionIdx >= 0) {
    const quoteLine = `> ${newValue}`;
    for (let i = sectionIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/^##\s+/.test(line)) {
        lines.splice(i, 0, "", quoteLine);
        return lines.join("\n");
      }

      if (!line) {
        continue;
      }

      if (line.startsWith(">")) {
        lines[i] = quoteLine;
        return lines.join("\n");
      }

      lines.splice(i, 0, quoteLine);
      return lines.join("\n");
    }

    lines.push("", quoteLine);
    return lines.join("\n");
  }

  const idx = lines.findIndex((l) => /^\s*一句话解释\s*[:：]/.test(l));

  const newLine = `一句话解释：${newValue}`;
  if (idx >= 0) {
    lines[idx] = newLine;
    return lines.join("\n");
  }

  // 没有找到就插入在标题后（更自然）
  // 找第一个以 "# " 开头的标题行
  const titleIdx = lines.findIndex((l) => /^\s*#\s+/.test(l));
  if (titleIdx >= 0) {
    // 插在标题下一行
    lines.splice(titleIdx + 1, 0, "", newLine, "");
    return lines.join("\n");
  }

  // 没标题就直接放最开头
  return [newLine, "", ...lines].join("\n");
}

function encodeCmdArgs(args: unknown): string {
  return encodeURIComponent(JSON.stringify(args));
}


function findWikiTermRange(document: vscode.TextDocument, term: string): vscode.Range | undefined {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\[\\[${escaped}\\]\\]`);
  const match = regex.exec(document.getText());

  if (!match || match.index < 0) {
    return undefined;
  }

  const start = document.positionAt(match.index);
  const end = document.positionAt(match.index + match[0].length);
  return new vscode.Range(start, end);
}

function extractContextHintFromDocument(document: vscode.TextDocument, range: vscode.Range): string | undefined {
  const startLine = Math.max(0, range.start.line - 2);
  const endLine = Math.min(document.lineCount - 1, range.end.line + 2);
  const start = new vscode.Position(startLine, 0);
  const end = new vscode.Position(endLine, document.lineAt(endLine).text.length);
  const text = document.getText(new vscode.Range(start, end));
  const compact = text.replace(/\r?\n/g, " ").trim();
  return compact.length > 0 ? compact.slice(0, 300) : undefined;
}

function parseConceptTitleTerm(fileText: string): string | null {
  const m = fileText.match(/^\s*#\s+(.+)\s*$/m);
  return m ? m[1].trim() : null;
}

function resolveConceptTermFromEditor(editorDoc: vscode.TextDocument | undefined): string | null {
  if (!editorDoc) {
    return null;
  }

  return parseConceptTitleTerm(editorDoc.getText());
}

function buildAiFailureMessage(prefix: string, rawMessage: string): string {
  const m = rawMessage.trim();
  const statusMatch = m.match(/AI HTTP\s+(\d{3})/i);
  const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;

  if (statusCode === 400) {
    return [
      `${prefix}${m}`,
      "可能原因：请求参数不符合接口要求（常见是 model/baseUrl 不匹配）。",
      "建议：检查 linklearn.ai.baseUrl 是否为官方兼容地址（例如 https://api.openai.com/v1），并确认 linklearn.ai.model 可用。",
    ].join("\n");
  }

  if (statusCode === 401) {
    return [
      `${prefix}${m}`,
      "可能原因：API Key 无效、已过期，或未正确保存到 VS Code 设置。",
      "建议：执行 “LinkLearn: Set API Key” 重新填写 linklearn.ai.apiKey，再重试。",
    ].join("\n");
  }

  if (statusCode === 403) {
    return [
      `${prefix}${m}`,
      "可能原因：当前 key 对目标模型/接口无权限，或组织策略限制访问。",
      "建议：更换有权限的 key，或切换 linklearn.ai.model 到你账号可用的模型。",
    ].join("\n");
  }

  if (statusCode === 404) {
    return [
      `${prefix}${m}`,
      "可能原因：接口地址或路径不正确（常见是 baseUrl 缺少 /v1，或网关未提供该路由）。",
      "建议：确认 linklearn.ai.baseUrl 指向 OpenAI-compatible 根地址，并包含正确版本路径。",
    ].join("\n");
  }

  if (statusCode === 429) {
    return [
      `${prefix}${m}`,
      "可能原因：触发频率限制（rate limit）或账户配额不足。",
      "建议：稍后重试，检查账户额度/账单，并降低并发请求。",
    ].join("\n");
  }

  return `${prefix}${m}`;
}

function buildTemplateNarrative(concept: ConceptJson, outputLanguage: OutputLanguage): string {
  const stripEndingPunctuation = (text: string): string => text.trim().replace(/[。；;，,、.!！?？]+$/g, "");
  const term = concept.term;
  if (outputLanguage === "en") {
    const oneLiner = concept.one_liner_en ?? "(to be added)";
    const detail = concept.detail_en ?? "(to be added)";
    const keyPoints = concept.key_points_en && concept.key_points_en.length > 0
      ? concept.key_points_en.map(stripEndingPunctuation).join(", ")
      : "(to be added)";
    const misconceptions = concept.misconceptions_en && concept.misconceptions_en.length > 0
      ? concept.misconceptions_en.map(stripEndingPunctuation).join("; ")
      : "none";

    return [
      `${term} can be understood as: ${oneLiner}`,
      detail,
      `Key points include: ${keyPoints}.`,
      `Common misconceptions: ${misconceptions}.`,
    ].join("\n");
  }

  if (outputLanguage === "bilingual") {
    const oneLinerZh = concept.one_liner_zh ?? "（待补充）";
    const detailZh = concept.detail_zh ?? "（待补充）";
    const oneLinerEn = concept.one_liner_en ?? "(to be added)";
    const detailEn = concept.detail_en ?? "(to be added)";

    return [
      `${term} can be understood as: ${oneLinerEn}`,
      detailEn,
      "",
      `${term}可以先理解为：${oneLinerZh}`,
      detailZh,
    ].join("\n");
  }

  const oneLiner = concept.one_liner_zh ?? "（待补充）";
  const detail = concept.detail_zh ?? "（待补充）";
  const keyPoints = concept.key_points_zh && concept.key_points_zh.length > 0
    ? concept.key_points_zh.map(stripEndingPunctuation).join("、")
    : "（待补充）";
  const misconceptions = concept.misconceptions_zh && concept.misconceptions_zh.length > 0
    ? concept.misconceptions_zh.map(stripEndingPunctuation).join("；")
    : "暂无明显误区";

  return [
    `${term}可以先理解为：${oneLiner}`,
    detail,
    `核心要点包括：${keyPoints}。`,
    `常见误区：${misconceptions}。`,
  ].join("\n");
}

function getOutputLanguage(): OutputLanguage {
  const raw = String(vscode.workspace.getConfiguration("linklearn").get("render.outputLanguage") ?? "zh").toLowerCase();
  if (LANGUAGE_OPTIONS.includes(raw as OutputLanguage) && raw !== "zh") {
    return raw as OutputLanguage;
  }
  return "zh";
}

function isContextEnabled(): boolean {
  return Boolean(vscode.workspace.getConfiguration("linklearn").get("generate.useContext") ?? true);
}

function asSection(title: string, content: string): string {
  const trimmed = content.trim();
  return [`## ${title}`, "", trimmed || "（待补充）", ""].join("\n");
}

async function openAndRevealLine(fileUri: vscode.Uri, lineNumber: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(fileUri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });

  const safeLine = Math.max(0, Math.min(lineNumber, doc.lineCount - 1));
  const lineText = doc.lineAt(safeLine).text;
  const position = new vscode.Position(safeLine, Math.max(0, lineText.search(/\S|$/)));
  const range = new vscode.Range(position, position);

  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
}

function findQaSectionLine(fileText: string): number {
  const lines = fileText.split(/\r?\n/);
  const markerIdx = lines.findIndex((line) => line.includes("<!-- LINKLEARN:QA:START -->"));
  if (markerIdx >= 0) {
    return Math.min(markerIdx + 1, lines.length - 1);
  }

  const headingIdx = lines.findIndex((line) => /^\s*##\s+Q&A\s*$/.test(line));
  return headingIdx >= 0 ? headingIdx : 0;
}

function appendQaEntry(fileText: string, question: string, answer: string): string {
  const qaBlock = `### Q: ${question}\n\n${answer}\n`;
  const startMarker = "<!-- LINKLEARN:QA:START -->";
  const endMarker = "<!-- LINKLEARN:QA:END -->";

  if (fileText.includes(startMarker) && fileText.includes(endMarker)) {
    return fileText.replace(endMarker, `${qaBlock}\n${endMarker}`);
  }

  const trimmed = fileText.trimEnd();
  return `${trimmed}\n\n${startMarker}\n## Q&A\n\n${qaBlock}\n${endMarker}\n`;
}

function buildGeneratedConceptMarkdown(concept: ConceptJson, naturalNarrative?: string): string {
  const outputLanguage = getOutputLanguage();
  if (outputLanguage === "en" && (!concept.one_liner_en || !concept.detail_en)) {
    throw new Error("Language contract broken: missing English field.");
  }
  if (outputLanguage === "zh" && (!concept.one_liner_zh || !concept.detail_zh)) {
    throw new Error("Language contract broken: missing Chinese field.");
  }
  if (outputLanguage === "bilingual" && (!concept.one_liner_en || !concept.detail_en || !concept.one_liner_zh || !concept.detail_zh)) {
    throw new Error("Language contract broken: missing bilingual field.");
  }

  const keyPointsZh = concept.key_points_zh && concept.key_points_zh.length > 0
    ? concept.key_points_zh.map((v) => `- ${v}`).join("\n")
    : "- （待补充）";
  const keyPointsEn = concept.key_points_en && concept.key_points_en.length > 0
    ? concept.key_points_en.map((v) => `- ${v}`).join("\n")
    : "- (to be added)";

  const misconceptionsZh = concept.misconceptions_zh && concept.misconceptions_zh.length > 0
    ? concept.misconceptions_zh.map((v) => `- ${v}`).join("\n")
    : "- （暂无）";
  const misconceptionsEn = concept.misconceptions_en && concept.misconceptions_en.length > 0
    ? concept.misconceptions_en.map((v) => `- ${v}`).join("\n")
    : "- (none)";

  const sections: string[] = [];

  sections.push("## 一句话解释\n");
  if (outputLanguage === "zh" || outputLanguage === "bilingual") {
    sections.push(`> ${concept.one_liner_zh ?? "（待补充）"}\n`);
  }
  if (outputLanguage === "en" || outputLanguage === "bilingual") {
    sections.push(`> ${concept.one_liner_en ?? "(to be added)"}\n`);
  }

  if (outputLanguage === "zh" || outputLanguage === "bilingual") {
    sections.push(asSection("详细解释", concept.detail_zh ?? "（待补充）"));
    sections.push(asSection("关键点", keyPointsZh));
    sections.push(asSection("常见误区", misconceptionsZh));
  }

  if (outputLanguage === "en" || outputLanguage === "bilingual") {
    sections.push(asSection("Detailed Explanation", concept.detail_en ?? "(to be added)"));
    sections.push(asSection("Key Points", keyPointsEn));
    sections.push(asSection("Common Misconceptions", misconceptionsEn));
  }

  const narrativeHeading = outputLanguage === "en" ? "## Narrative" : "## 自然讲解";

  return `# ${concept.term}

${sections.join("\n")}

${narrativeHeading}

${(naturalNarrative ?? buildTemplateNarrative(concept, outputLanguage)).trim()}
`;
}

async function readTextFile(uri: vscode.Uri): Promise<string> {
  const data = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(data).toString("utf8");
}

async function writeTextFile(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
}

async function writeLinklearnApiKey(): Promise<boolean> {
  const apiKey = await vscode.window.showInputBox({
    prompt: "填写 LinkLearn 的 API Key（将保存到用户 settings.json）",
    placeHolder: "sk-...",
    password: true,
    ignoreFocusOut: true,
  });

  if (apiKey === undefined) {
    return false;
  }

  await vscode.workspace
    .getConfiguration("linklearn")
    .update("ai.apiKey", apiKey.trim(), vscode.ConfigurationTarget.Global);

  vscode.window.showInformationMessage("LinkLearn: 已保存 linklearn.ai.apiKey 到用户设置");
  return true;
}

// ====== Concept 存储层（缓存 + 文件定位 + 自动创建） ======

type CacheEntry = {
  mtime: number; // 文件最后修改时间
  explain: string; // 一句话解释（可能为空字符串）
};

class ConceptStore {
  /**
   * 缓存 key 用 concept 文件的 fsPath（包含 workspace 差异）
   * 这样多 workspace 时不会串。
   */
  private explainCache = new Map<string, CacheEntry>();

  /** watcher 需要管理生命周期 */
  private watchers: vscode.FileSystemWatcher[] = [];

  constructor(private context: vscode.ExtensionContext) {}

  dispose() {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    this.explainCache.clear();
  }

  /** 建立 watcher：监听概念文件改动 -> 缓存失效 */
  installWatchers() {
    // 先清理旧 watcher
    for (const w of this.watchers) w.dispose();
    this.watchers = [];

    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      // 只监听当前 workspace folder 下的 .linklearn/concepts/*.md
      const pattern = new vscode.RelativePattern(
        folder,
        `${CONCEPT_DIR.join("/")}/**/*.md`
      );
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      const invalidate = (uri: vscode.Uri) => this.invalidateByUri(uri);
      watcher.onDidChange(invalidate);
      watcher.onDidCreate(invalidate);
      watcher.onDidDelete(invalidate);

      this.watchers.push(watcher);
      this.context.subscriptions.push(watcher);
    }
  }

  invalidateByUri(uri: vscode.Uri) {
    // 文件变化：删掉对应缓存
    this.explainCache.delete(uri.fsPath);
  }

  /** 根据“当前文档”决定使用哪个 workspace folder（多 workspace 时很关键） */
  getWorkspaceFolderForDocument(docUri: vscode.Uri): vscode.WorkspaceFolder | null {
    const folder = vscode.workspace.getWorkspaceFolder(docUri);
    if (folder) return folder;

    // fallback：如果 doc 不在任何 workspace folder 中，就用第一个
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.length > 0 ? folders[0] : null;
  }

  /** concept 文件路径：<workspace>/.linklearn/concepts/<term>.md */
  getConceptUri(folder: vscode.WorkspaceFolder, term: string): vscode.Uri {
    const safe = sanitizeFileName(term);
    return vscode.Uri.joinPath(folder.uri, ...CONCEPT_DIR, `${safe}.md`);
  }

  /** 确保 concept 文件存在（目录和文件都自动创建） */
  async ensureConceptFile(folder: vscode.WorkspaceFolder, term: string): Promise<vscode.Uri> {
    const fileUri = this.getConceptUri(folder, term);

    // 确保目录存在
    const dirUri = vscode.Uri.joinPath(folder.uri, ...CONCEPT_DIR);
    try {
      await vscode.workspace.fs.createDirectory(dirUri);
    } catch {
      // createDirectory 对已存在目录通常不报错；就算报也无所谓
    }

    // 确保文件存在
    try {
      await vscode.workspace.fs.stat(fileUri);
    } catch {
      const template =
        `# ${term}\n\n` +
        `一句话解释：\n\n` +
        `详细解释：\n`;
      await writeTextFile(fileUri, template);
    }

    return fileUri;
  }

  /** 获取一句话解释（带缓存） */
  async getOneLineExplain(folder: vscode.WorkspaceFolder, term: string): Promise<string> {
    const fileUri = await this.ensureConceptFile(folder, term);

    // 读 stat 获取 mtime，用来判断缓存是否过期
    const stat = await vscode.workspace.fs.stat(fileUri);
    const cached = this.explainCache.get(fileUri.fsPath);
    if (cached && cached.mtime === stat.mtime) {
      return cached.explain;
    }

    const text = await readTextFile(fileUri);
    const explain = parseOneLineExplain(text) ?? "";
    this.explainCache.set(fileUri.fsPath, { mtime: stat.mtime, explain });
    return explain;
  }

  /** 更新一句话解释：写回文件 + 让缓存失效（或更新） */
  async setOneLineExplain(folder: vscode.WorkspaceFolder, term: string, newExplain: string): Promise<void> {
    const fileUri = await this.ensureConceptFile(folder, term);
    const oldText = await readTextFile(fileUri);
    const newText = upsertOneLineExplain(oldText, newExplain);
    await writeTextFile(fileUri, newText);

    // 写完以后 stat.mtime 会变化，保险起见直接 invalidate
    this.invalidateByUri(fileUri);
  }

  async setGeneratedConcept(folder: vscode.WorkspaceFolder, concept: ConceptJson, naturalNarrative?: string): Promise<vscode.Uri> {
    const fileUri = await this.ensureConceptFile(folder, concept.term);
    const markdown = buildGeneratedConceptMarkdown(concept, naturalNarrative);
    await writeTextFile(fileUri, markdown);
    this.invalidateByUri(fileUri);
    return fileUri;
  }

  async appendQa(folder: vscode.WorkspaceFolder, term: string, question: string, answer: string): Promise<vscode.Uri> {
    const fileUri = await this.ensureConceptFile(folder, term);
    const oldText = await readTextFile(fileUri);
    const newText = appendQaEntry(oldText, question, answer);
    await writeTextFile(fileUri, newText);
    this.invalidateByUri(fileUri);
    return fileUri;
  }
}

// ====== 主逻辑 ======

export async function activate(context: vscode.ExtensionContext) {
  const store = new ConceptStore(context);

  // 安装 watcher（概念文件变化 -> 缓存失效）
  store.installWatchers();

  // workspace folders 变化时，重建 watcher（多 workspace 场景更稳）
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      store.installWatchers();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("linklearn.render.outputLanguage")) {
        console.log("[LinkLearn] outputLanguage changed:", getOutputLanguage());
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "linklearn.helloWorld",
      () => {
        vscode.window.showInformationMessage("Hello World from LinkLearn!");
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "linklearn.setApiKey",
      async () => {
        await writeLinklearnApiKey();
      }
    )
  );

  // ------- Command: 打开 concept 文件 -------
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "linklearn.openConcept",
      async (args: { term: string; sourceUri?: string } | string) => {
        // 兼容两种传参：直接传 term 字符串，或传对象
        const term =
          typeof args === "string" ? args : (args?.term ?? "");
        if (!term) return;

        const sourceUri = typeof args === "string" ? undefined : args?.sourceUri;
        const docUri = sourceUri ? vscode.Uri.parse(sourceUri) : vscode.window.activeTextEditor?.document.uri;

        if (!docUri) {
          vscode.window.showWarningMessage("LinkLearn: 无法确定当前文档（请先打开一个文件）");
          return;
        }

        const folder = store.getWorkspaceFolderForDocument(docUri);
        if (!folder) {
          vscode.window.showWarningMessage("LinkLearn: 请先在 Extension Host 窗口打开一个 Folder/Workspace");
          return;
        }

        const fileUri = await store.ensureConceptFile(folder, term);
        await vscode.commands.executeCommand("vscode.open", fileUri);
      }
    )
  );

  // ------- Command: 编辑“一句话解释” -------
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "linklearn.editExplanation",
      async (args: { term: string; sourceUri?: string } | string) => {
        const term =
          typeof args === "string" ? args : (args?.term ?? "");
        if (!term) return;

        const sourceUri = typeof args === "string" ? undefined : args?.sourceUri;
        const docUri = sourceUri ? vscode.Uri.parse(sourceUri) : vscode.window.activeTextEditor?.document.uri;

        if (!docUri) {
          vscode.window.showWarningMessage("LinkLearn: 无法确定当前文档（请先打开一个文件）");
          return;
        }

        const folder = store.getWorkspaceFolderForDocument(docUri);
        if (!folder) {
          vscode.window.showWarningMessage("LinkLearn: 请先在 Extension Host 窗口打开一个 Folder/Workspace");
          return;
        }

        const oldExplain = await store.getOneLineExplain(folder, term);

        const input = await vscode.window.showInputBox({
          prompt: `编辑「${term}」的一句话解释`,
          value: oldExplain ?? "",
          ignoreFocusOut: true,
        });

        // 用户按 ESC 会是 undefined；按 OK 可能是空字符串（允许）
        if (input === undefined) return;

        await store.setOneLineExplain(folder, term, input);
        vscode.window.showInformationMessage(`LinkLearn: 已更新「${term}」的一句话解释`);
      }
    )
  );

  // ------- Hover Provider -------
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "linklearn.generateConcept",
      async (args: { term: string; sourceUri?: string } | string) => {
        const passedTerm = typeof args === "string" ? args : (args?.term ?? "");
        const sourceUri = typeof args === "string" ? undefined : args?.sourceUri;
        const docUri = sourceUri ? vscode.Uri.parse(sourceUri) : vscode.window.activeTextEditor?.document.uri;

        if (!docUri) {
          vscode.window.showWarningMessage("LinkLearn: 无法确定当前文档（请先打开一个文件）");
          return;
        }

        const folder = store.getWorkspaceFolderForDocument(docUri);
        if (!folder) {
          vscode.window.showWarningMessage("LinkLearn: 请先在 Extension Host 窗口打开一个 Folder/Workspace");
          return;
        }

        const editorDoc = vscode.window.activeTextEditor?.document;
        const fileTerm = resolveConceptTermFromEditor(editorDoc);
        const term = (passedTerm || fileTerm || await vscode.window.showInputBox({
          prompt: "输入要生成详细解释的术语",
          placeHolder: "例如：卷积",
          ignoreFocusOut: true,
        }))?.trim();

        if (!term) return;

        const outputLanguage = getOutputLanguage();
        const useContext = isContextEnabled();

        let contextHint: string | undefined;
        if (useContext) {
          const sourceDoc = await vscode.workspace.openTextDocument(docUri);
          const termRange = findWikiTermRange(sourceDoc, term);
          contextHint = termRange ? extractContextHintFromDocument(sourceDoc, termRange) : undefined;
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `LinkLearn: 正在生成「${term}」的概念解释...`,
              cancellable: false,
            },
            async (progress) => {
              progress.report({ message: "正在读取 AI 配置..." });
              const ai = createProvider();

              progress.report({ message: "正在请求模型生成内容..." });
              const concept = await ai.generateConcept(term, contextHint?.trim() || undefined, outputLanguage);

              const renderMode = String(
                vscode.workspace.getConfiguration("linklearn").get("render.naturalMode") ?? "template"
              ).toLowerCase();
              let naturalNarrative: string | undefined;

              if (renderMode === "ai" && typeof ai.renderConceptNarrative === "function") {
                progress.report({ message: "正在生成自然语言讲解..." });
                naturalNarrative = await ai.renderConceptNarrative(concept, outputLanguage);
              }

              progress.report({ message: "正在写入 concepts 文件..." });
              const fileUri = await store.setGeneratedConcept(folder, concept, naturalNarrative);
              await vscode.commands.executeCommand("vscode.open", fileUri);
            }
          );

          vscode.window.showInformationMessage(`LinkLearn: 已自动生成并填充「${term}」的一句话解释与详细解释`);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const detail = buildAiFailureMessage("LinkLearn: 自动生成失败。", message);
          const openSettings = "打开 LinkLearn AI 设置";

          const action = await vscode.window.showErrorMessage(
            detail,
            openSettings
          );

          if (action === openSettings) {
            await vscode.commands.executeCommand("workbench.action.openSettingsJson");
          }
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "linklearn.askConcept",
      async (args: { term?: string; sourceUri?: string } | string) => {
        const sourceUri = typeof args === "string" ? undefined : args?.sourceUri;
        const docUri = sourceUri ? vscode.Uri.parse(sourceUri) : vscode.window.activeTextEditor?.document.uri;

        if (!docUri) {
          vscode.window.showWarningMessage("LinkLearn: 无法确定当前文档（请先打开一个文件）");
          return;
        }

        const folder = store.getWorkspaceFolderForDocument(docUri);
        if (!folder) {
          vscode.window.showWarningMessage("LinkLearn: 请先在 Extension Host 窗口打开一个 Folder/Workspace");
          return;
        }

        const editorDoc = vscode.window.activeTextEditor?.document;
        const fileTerm = resolveConceptTermFromEditor(editorDoc);
        const passedTerm = typeof args === "string" ? args : (args?.term ?? "");
        const term = (passedTerm || fileTerm || await vscode.window.showInputBox({
          prompt: "输入要提问的术语",
          placeHolder: "例如：卷积",
          ignoreFocusOut: true,
        }))?.trim();

        if (!term) return;

        const question = (await vscode.window.showInputBox({
          prompt: `你想问「${term}」什么问题？`,
          placeHolder: "例如：生成一句话解释",
          ignoreFocusOut: true,
        }))?.trim();

        if (!question) return;

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `LinkLearn: 正在回答「${term}」的问题...`,
              cancellable: false,
            },
            async (progress) => {
              progress.report({ message: "正在读取 AI 配置..." });
              const ai = createProvider();

              progress.report({ message: "正在读取概念文件上下文..." });
              const conceptUri = await store.ensureConceptFile(folder, term);
              const conceptBody = await readTextFile(conceptUri);

              progress.report({ message: "正在请求模型回答..." });
              const answer = await ai.answerConceptQuestion(term, question, conceptBody);

              progress.report({ message: "正在写入 Q&A..." });
              const fileUri = await store.appendQa(folder, term, question, answer);
              const latestText = await readTextFile(fileUri);
              const qaLine = findQaSectionLine(latestText);
              await openAndRevealLine(fileUri, qaLine);
            }
          );

          vscode.window.showInformationMessage(`LinkLearn: 已记录「${term}」的问答`);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const setApiKey = "填写 API Key";
          const openSettings = "打开 settings.json";
          const detail = buildAiFailureMessage("LinkLearn: 提问失败。", message);

          const action = await vscode.window.showErrorMessage(
            detail,
            setApiKey,
            openSettings
          );

          if (action === setApiKey) {
            await vscode.commands.executeCommand("linklearn.setApiKey");
          }
          if (action === openSettings) {
            await vscode.commands.executeCommand("workbench.action.openSettingsJson");
          }
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [
        { scheme: "file", language: "markdown" },
        { scheme: "file", language: "mdx" },
      ],
      {
        provideHover: async (document, position) => {
          // 找到光标处的 [[term]]
          const range = document.getWordRangeAtPosition(position, /\[\[[^\]]+\]\]/);
          if (!range) return undefined;

          const raw = document.getText(range);
          const term = extractTermFromBrackets(raw);
          if (!term) return undefined;

          const folder = store.getWorkspaceFolderForDocument(document.uri);
          if (!folder) {
            // Hover 里不疯狂弹窗，只返回提示
            const md = new vscode.MarkdownString("LinkLearn: 请先打开一个 Folder/Workspace 才能创建 concepts。");
            return new vscode.Hover(md, range);
          }

          const explain = await store.getOneLineExplain(folder, term);

          // Hover 内容：解释 + 紧凑操作链接
          const md = new vscode.MarkdownString();
          const safeExplain = explain
            .trim()
            .replace(/^一句话解释\s*[:：]\s*/i, "")
            .trim();
          const shouldShowExplain =
            safeExplain.length > 0 &&
            !/^详细解释\s*[:：]?$/i.test(safeExplain) &&
            !/^detailed explanation\s*[:：]?$/i.test(safeExplain);
          if (shouldShowExplain) {
            md.appendMarkdown(`**${safeExplain}**\n\n`);
          }

          // command 参数：term + 当前文档 uri（用于多 workspace 正确定位）
          const args = { term, sourceUri: document.uri.toString() };

          md.appendMarkdown(
            `[generate](command:linklearn.generateConcept?${encodeCmdArgs(args)}) · ` +
            `[view](command:linklearn.openConcept?${encodeCmdArgs(args)}) · ` +
            `[edit](command:linklearn.editExplanation?${encodeCmdArgs(args)}) · ` +
            `[ask](command:linklearn.askConcept?${encodeCmdArgs(args)})`
          );

          // 允许 command 链接
          md.isTrusted = true;

          return new vscode.Hover(md, range);
        },
      }
    )
  );

  // 让 VSCode 能自动清理
  context.subscriptions.push({ dispose: () => store.dispose() });
}

export function deactivate() {
  // 资源由 context.subscriptions 自动清理即可
}
