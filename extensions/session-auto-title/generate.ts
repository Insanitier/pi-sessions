import {
  type Api,
  completeSimple,
  type Model,
  type TextContent,
  type UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoTitleContext } from "./context.js";
import type { AutoTitleTrigger } from "./state.js";

const AUTO_TITLE_REQUEST_TIMEOUT_MS = 15_000;
const AUTO_TITLE_MAX_TOKENS = 64;
const AUTO_TITLE_CHAR_MAX = 120;

export interface AutoTitleFailure {
  at: string;
  trigger: AutoTitleTrigger;
  model: string;
  message: string;
}

export type AutoTitleGenerationResult =
  | {
      ok: true;
      title: string;
    }
  | {
      ok: false;
      failure: AutoTitleFailure;
    };

export async function generateAutoTitle(
  ctx: ExtensionContext,
  model: Model<Api>,
  context: AutoTitleContext,
  trigger: AutoTitleTrigger,
  systemPrompt: string,
): Promise<AutoTitleGenerationResult> {
  if (!context.conversationText) {
    return {
      ok: false,
      failure: createAutoTitleFailure(
        trigger,
        model,
        "No conversation available for auto-title generation.",
      ),
    };
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return {
      ok: false,
      failure: createAutoTitleFailure(trigger, model, "Failed to authenticate auto-title model."),
    };
  }

  const message: UserMessage = {
    role: "user",
    content: [{ type: "text", text: buildAutoTitlePrompt(context, trigger) }],
    timestamp: Date.now(),
  };

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), AUTO_TITLE_REQUEST_TIMEOUT_MS);

  try {
    const response = await completeSimple(
      model,
      {
        systemPrompt,
        messages: [message],
      },
      {
        ...(auth.apiKey && { apiKey: auth.apiKey }),
        ...(auth.headers && { headers: auth.headers }),
        maxTokens: AUTO_TITLE_MAX_TOKENS,
        signal: abortController.signal,
      },
    );

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      const fallbackMessage =
        response.stopReason === "aborted" ? "Request was aborted." : "Provider returned an error.";
      return {
        ok: false,
        failure: createAutoTitleFailure(trigger, model, response.errorMessage || fallbackMessage),
      };
    }

    const normalizedTitle = normalizeGeneratedAutoTitle(extractResponseText(response.content));
    if (!normalizedTitle) {
      return {
        ok: false,
        failure: createAutoTitleFailure(trigger, model, "Model returned an empty title."),
      };
    }

    return {
      ok: true,
      title: normalizedTitle,
    };
  } catch (error) {
    return {
      ok: false,
      failure: createAutoTitleFailure(trigger, model, extractErrorMessage(error)),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createAutoTitleFailure(
  trigger: AutoTitleTrigger,
  model: Model<Api> | undefined,
  message: string,
): AutoTitleFailure {
  return {
    at: new Date().toISOString(),
    trigger,
    model: formatModelLabel(model),
    message,
  };
}

function buildAutoTitlePrompt(context: AutoTitleContext, trigger: AutoTitleTrigger): string {
  const sections = [
    ["## Trigger", trigger],
    ["## Current Title", context.currentTitle ?? "(none)"],
    ["## Counts", formatCounts(context)],
    ["## Conversation", context.conversationText || "(none)"],
  ];

  if (context.cwd) {
    sections.unshift(["## Cwd", context.cwd]);
  }

  return sections.map(([heading, body]) => `${heading}\n${body}`).join("\n\n");
}

function normalizeGeneratedAutoTitle(value: string): string | undefined {
  const withoutQuotes = value.trim().replace(/^["'`]+|["'`]+$/g, "");
  const collapsed = withoutQuotes
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!collapsed) {
    return undefined;
  }

  const truncated = collapsed.slice(0, AUTO_TITLE_CHAR_MAX).trim();
  return truncated || undefined;
}

function extractResponseText(content: unknown[]): string {
  return content
    .filter(
      (part): part is TextContent =>
        isObject(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function formatCounts(context: AutoTitleContext): string {
  return [
    `user_turns: ${context.userTurnCount}`,
    `assistant_turns: ${context.assistantTurnCount}`,
  ].join("\n");
}

function formatModelLabel(model: Model<Api> | undefined): string {
  if (!model) {
    return "(no model resolved)";
  }

  return `${model.provider}/${model.id}`;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  return "Unknown provider error.";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
