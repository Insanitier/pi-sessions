import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildSessionContext,
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { parseTypeBoxValue } from "../shared/typebox.js";

const MAX_RELEVANT_FILES = 12;

const HANDOFF_SYSTEM_PROMPT = `You are an expert technical lead preparing a deliberate session handoff. Your goal is to equip a fresh agent with the precise context needed to seamlessly continue the work.

You must call the handoff tool (e.g., create_handoff_context) exactly once to generate the document.

Adhere to these professional guidelines when constructing the context:

### 1. Core Context (Lean & Concrete)
- **title**: Ultra-short, 3 to 6 words. Think of it like a Git commit title. No prefixes like "Handoff:".
- **nextTask**: The concrete, immediate next action. If the user passed arguments, use them to strictly tailor this task.
- **summary**: High-signal summary of the current state. Extract only context materially relevant to the next task.

### 2. Information Hygiene (Crucial Subtractions)
- **Reference, Don't Duplicate**: Never copy content already captured in artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them via workspace-relative paths or URLs to save context window.
- **Security**: Automatically redact sensitive information (API keys, passwords, tokens, PII) before finalizing the document.

### Constraints
- Prefer workspace-relative file paths when referencing existing code.
- Do not write the final execution prompt for the next agent yourself; focus solely on the context document.`;

const HANDOFF_EXTRACTION_PARAMETERS = Type.Object({
  title: Type.String({
    description: "Short display title for the new handoff session.",
  }),
  summary: Type.String({
    description: "Only the context relevant to the next task.",
  }),
  relevantFiles: Type.Array(Type.String(), {
    description: "Relevant workspace-relative file paths when possible.",
  }),
  nextTask: Type.String({
    description: "The concrete next task for the new session.",
  }),
});

type HandoffExtractionArgs = Static<typeof HANDOFF_EXTRACTION_PARAMETERS>;
type RequiredHandoffExtractionArgs = Static<typeof REQUIRED_HANDOFF_EXTRACTION_PARAMETERS>;

const REQUIRED_HANDOFF_EXTRACTION_PARAMETERS = Type.Object({
  title: HANDOFF_EXTRACTION_PARAMETERS.properties.title,
  summary: HANDOFF_EXTRACTION_PARAMETERS.properties.summary,
  nextTask: HANDOFF_EXTRACTION_PARAMETERS.properties.nextTask,
});

export interface HandoffContext {
  title: string;
  summary: string;
  relevantFiles: string[];
  nextTask: string;
}

export interface HandoffDraftResult {
  draft: string;
  context: HandoffContext;
  sessionId: string;
  sessionPath?: string | undefined;
}

export async function generateHandoffDraft(
  ctx: ExtensionContext,
  goal: string,
  thinkingLevel: ThinkingLevel | undefined,
  signal?: AbortSignal,
  extractionModel?: Model<Api>,
): Promise<HandoffDraftResult | undefined> {
  const model = extractionModel ?? ctx.model;
  if (!model) {
    throw new Error("No model is available for handoff.");
  }
  const sessionContext = buildSessionContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
  );
  if (sessionContext.messages.length === 0) {
    throw new Error("No conversation is available to hand off.");
  }

  const conversationText = serializeConversation(convertToLlm(sessionContext.messages));
  const handoffContext = await runHandoffExtractionAgent(
    ctx,
    model,
    conversationText,
    goal,
    thinkingLevel,
    signal,
  );
  if (!handoffContext) {
    return undefined;
  }

  const sessionId = ctx.sessionManager.getSessionId();
  const sessionPath = ctx.sessionManager.getSessionFile();

  return {
    draft: assembleHandoffDraft(sessionId, sessionPath, handoffContext, goal),
    context: handoffContext,
    sessionId,
    sessionPath,
  };
}

export function buildExtractionPrompt(conversationText: string, goal: string): string {
  return [
    "## Conversation",
    conversationText,
    "",
    "## Goal",
    goal,
    "",
    "Call create_handoff_context exactly once.",
  ].join("\n");
}

async function runHandoffExtractionAgent(
  ctx: ExtensionContext,
  model: Model<Api>,
  conversationText: string,
  goal: string,
  thinkingLevel: ThinkingLevel | undefined,
  signal?: AbortSignal,
): Promise<HandoffContext | undefined> {
  let capturedArguments: HandoffExtractionArgs | undefined;
  const createHandoffContextTool = defineTool({
    name: "create_handoff_context",
    label: "Create handoff context",
    description: "Extract the structured handoff context for the next session.",
    parameters: HANDOFF_EXTRACTION_PARAMETERS,
    execute: async (_toolCallId, params) => {
      capturedArguments = params;
      return {
        content: [{ type: "text", text: "Handoff context captured. Stopping." }],
        details: {},
        terminate: true,
      };
    },
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    appendSystemPromptOverride: (base) => [...base, HANDOFF_SYSTEM_PROMPT],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    model,
    modelRegistry: ctx.modelRegistry,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    tools: ["read", "grep", "find", "ls", "create_handoff_context"],
    customTools: [createHandoffContextTool],
    resourceLoader,
    sessionManager: SessionManager.inMemory(ctx.cwd),
  });

  const abortHandler = (): void => {
    void session.abort();
  };

  try {
    signal?.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted) {
      await session.abort();
      return undefined;
    }

    await session.prompt(buildExtractionPrompt(conversationText, goal));
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    session.dispose();
  }

  if (signal?.aborted) {
    return undefined;
  }

  if (!capturedArguments) {
    throw new Error("Handoff extraction did not return structured context.");
  }

  const extraction = extractHandoffContextFromArguments(capturedArguments, goal);
  if (!extraction.context) {
    throw new Error(extraction.error);
  }

  return extraction.context;
}

export function assembleHandoffDraft(
  sessionId: string,
  sessionPath: string | undefined,
  handoffContext: HandoffContext,
  goal: string,
): string {
  const sections = [buildContinuityLine(sessionId, sessionPath)];
  const nextTask = handoffContext.nextTask.trim() || goal.trim();

  if (nextTask) {
    sections.push(["## Task", nextTask].join("\n"));
  }

  if (handoffContext.relevantFiles.length > 0) {
    sections.push(
      [
        "## Relevant Files",
        ...handoffContext.relevantFiles.map((filePath) => `- ${filePath}`),
      ].join("\n"),
    );
  }

  if (handoffContext.summary) {
    sections.push(["## Context", handoffContext.summary].join("\n"));
  }

  return sections.join("\n\n").trim();
}

export function extractHandoffContext(
  response: AssistantMessage,
  goal: string,
): { context: HandoffContext; error?: undefined } | { context?: undefined; error: string } {
  const toolCall = response.content.find(isCreateHandoffContextToolCall);
  if (!toolCall) {
    return { error: "Handoff extraction did not return structured context." };
  }

  return extractHandoffContextFromArguments(toolCall.arguments, goal);
}

function extractHandoffContextFromArguments(
  argumentsValue: unknown,
  goal: string,
): { context: HandoffContext; error?: undefined } | { context?: undefined; error: string } {
  let requiredArguments: RequiredHandoffExtractionArgs;
  try {
    requiredArguments = parseTypeBoxValue(
      REQUIRED_HANDOFF_EXTRACTION_PARAMETERS,
      argumentsValue,
      "Invalid create_handoff_context arguments",
    );
  } catch {
    return { error: "Handoff extraction did not return structured context." };
  }

  const title = normalizeText(requiredArguments.title);
  const summary = normalizeText(requiredArguments.summary);
  const relevantFiles = getRelevantFiles(argumentsValue);
  const nextTask = normalizeText(requiredArguments.nextTask) || goal.trim();

  if (!summary || !nextTask || !title) {
    return { error: "Handoff extraction did not return structured context." };
  }

  return {
    context: {
      title,
      summary,
      relevantFiles,
      nextTask,
    },
  };
}

function buildContinuityLine(sessionId: string, _sessionPath: string | undefined): string {
  return `Continuing work from session ${sessionId}. When you lack specific information you can use session_ask.`;
}

function normalizeStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const uniqueValues = new Set<string>();
  for (const item of value) {
    const normalized = normalizeText(item);
    if (!normalized) {
      continue;
    }

    uniqueValues.add(normalized);
    if (uniqueValues.size >= limit) {
      break;
    }
  }

  return [...uniqueValues];
}

function getRelevantFiles(argumentsValue: unknown): string[] {
  if (!isRecord(argumentsValue)) {
    return [];
  }

  return normalizeStringArray(argumentsValue.relevantFiles, MAX_RELEVANT_FILES);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCreateHandoffContextToolCall(
  content: TextContent | ThinkingContent | ToolCall,
): content is ToolCall {
  return content.type === "toolCall" && content.name === "create_handoff_context";
}
