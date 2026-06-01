import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { generateHandoffDraft, type HandoffDraftResult } from "./session-handoff/extract.js";
import {
  createHandoffBootstrap,
  createHandoffSessionMetadata,
  encodeHandoffBootstrap,
  getHandoffMetadataFromEntries,
  HANDOFF_BOOTSTRAP_ENV,
  HANDOFF_METADATA_CUSTOM_TYPE,
  HANDOFF_STALE_SESSION_MESSAGE,
  hasUserMessages,
  parseHandoffBootstrap,
} from "./session-handoff/metadata.js";
import { openSessionReferencePicker } from "./session-handoff/picker.js";
import { SESSION_TOKEN_PREFIX } from "./session-handoff/query.js";
import { renderStrongModal, reviewHandoffDraft } from "./session-handoff/review.js";
import {
  buildPiResumeCommand,
  createHandoffSession,
  type HandoffSplitDirection,
  launchSplitHandoffSession,
  validateSplitHandoffPrerequisites,
} from "./session-handoff/spawn.js";
import { loadSettings } from "./shared/settings.js";

const HANDOFF_USAGE = "Usage: /handoff [--left|--right|--up|--down] <goal for new thread>";

interface HandoffPromptContext {
  ui: ExtensionCommandContext["ui"];
  sendUserMessage(content: string): Promise<void>;
}

export default function sessionHandoffExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();

  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      if (!ctx.hasUI) {
        ctx.ui.notify("handoff requires interactive mode", "error");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      const parsedArgs = parseHandoffCommandArgs(args);
      if (parsedArgs.kind === "error") {
        ctx.ui.notify(parsedArgs.message, "error");
        return;
      }

      const sessionContext = buildSessionContext(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getLeafId(),
      );
      if (sessionContext.messages.length === 0) {
        ctx.ui.notify("No conversation to hand off", "error");
        return;
      }

      if (parsedArgs.splitDirection) {
        const preflightError = await validateSplitHandoffPrerequisites(pi, ctx);
        if (preflightError) {
          ctx.ui.notify(preflightError, "error");
          return;
        }
      }

      let generatedDraft: HandoffDraftResult | undefined;
      try {
        generatedDraft = await runWithLoader(
          ctx,
          "Generating handoff draft...",
          async (signal: AbortSignal) => generateHandoffDraft(ctx, parsedArgs.goal, signal),
        );
      } catch (error) {
        ctx.ui.notify(formatHandoffError(error), "error");
        return;
      }

      if (!generatedDraft) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      const approvedDraft = await reviewHandoffDraft(ctx, generatedDraft.draft);
      if (!approvedDraft) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      const parentSessionFile = ctx.sessionManager.getSessionFile();
      if (!parentSessionFile) {
        ctx.ui.notify("Handoff requires a persisted current session.", "error");
        return;
      }

      const handoffMetadata = createHandoffSessionMetadata(
        parsedArgs.goal,
        generatedDraft.context.nextTask,
        approvedDraft,
        generatedDraft.context.title,
      );
      if (parsedArgs.splitDirection) {
        const createdSession = createHandoffSession({
          cwd: ctx.cwd,
          sessionDir: ctx.sessionManager.getSessionDir(),
          parentSessionFile,
          title: handoffMetadata.title,
        });
        const bootstrapValue = encodeHandoffBootstrap(
          createHandoffBootstrap(createdSession.sessionId, handoffMetadata),
        );
        const launchResult = await launchSplitHandoffSession(pi, {
          cwd: ctx.cwd,
          sessionDir: ctx.sessionManager.getSessionDir(),
          direction: parsedArgs.splitDirection,
          sessionId: createdSession.sessionId,
          bootstrapValue,
          title: handoffMetadata.title,
        });

        if (!launchResult.success) {
          ctx.ui.notify(
            `${launchResult.error} Created handoff session ${createdSession.sessionId}; start it manually with: ${buildPiResumeCommand(ctx.sessionManager.getSessionDir(), createdSession.sessionId, bootstrapValue, handoffMetadata.title)}`,
            "error",
          );
          return;
        }

        ctx.ui.notify(`Handoff started in a new pane (${parsedArgs.splitDirection}).`, "info");
        return;
      }

      const switchResult = await ctx.newSession({
        parentSession: parentSessionFile,
        setup: async (sessionManager) => {
          sessionManager.appendSessionInfo(handoffMetadata.title);
          sessionManager.appendCustomEntry(HANDOFF_METADATA_CUSTOM_TYPE, handoffMetadata);
        },
        withSession: async (nextCtx) => {
          startHandoffPromptAfterSessionRender(nextCtx, approvedDraft);
        },
      });

      if (switchResult.cancelled) {
        ctx.ui.notify("Session switch cancelled", "info");
      }
    },
  });

  pi.registerShortcut(settings.handoff.pickerShortcut, {
    description: "Open the session reference picker",
    handler: async (ctx) => {
      if (!ctx.hasUI) {
        return;
      }

      const result = await openSessionReferencePicker(
        ctx,
        settings.index.path,
        settings.handoff.pickerShortcut,
      );
      if (result.kind !== "insert-session-token") {
        return;
      }

      ctx.ui.pasteToEditor(`${SESSION_TOKEN_PREFIX}${result.sessionId}`);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const encodedBootstrap = process.env[HANDOFF_BOOTSTRAP_ENV];
    if (!encodedBootstrap) {
      return;
    }

    const bootstrap = parseHandoffBootstrap(encodedBootstrap);
    if (!bootstrap) {
      delete process.env[HANDOFF_BOOTSTRAP_ENV];
      return;
    }

    if (bootstrap.sessionId !== ctx.sessionManager.getSessionId()) {
      return;
    }

    try {
      const entries = ctx.sessionManager.getEntries();
      if (hasUserMessages(entries)) {
        if (ctx.hasUI) {
          ctx.ui.notify(HANDOFF_STALE_SESSION_MESSAGE, "error");
        }
        return;
      }

      if (!getHandoffMetadataFromEntries(entries)) {
        pi.appendEntry(
          HANDOFF_METADATA_CUSTOM_TYPE,
          createHandoffSessionMetadata(
            bootstrap.goal,
            bootstrap.nextTask,
            bootstrap.initialPrompt,
            bootstrap.title,
          ),
        );
      }

      if (!ctx.sessionManager.getSessionName()) {
        pi.setSessionName(bootstrap.title);
      }

      pi.sendUserMessage(bootstrap.initialPrompt);
    } finally {
      delete process.env[HANDOFF_BOOTSTRAP_ENV];
    }
  });

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\nWhen the user references @session:<uuid>, treat it as a session token. If you call session_ask, pass only the UUID value, not the @session: prefix.",
    };
  });
}

async function runWithLoader<T>(
  ctx: ExtensionCommandContext,
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  let taskError: unknown;

  const result = await ctx.ui.custom<T | undefined>(
    (tui, theme, _keybindings, done) => {
      const abortController = new AbortController();

      task(abortController.signal)
        .then(done)
        .catch((error: unknown) => {
          if (!abortController.signal.aborted) {
            taskError = error;
          }
          done(undefined);
        });

      return {
        render(width: number): string[] {
          return renderStrongModal(
            [theme.fg("accent", theme.bold(label)), "", theme.fg("muted", "Press Esc to cancel.")],
            width,
            theme,
          );
        },
        invalidate(): void {},
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            abortController.abort();
            done(undefined);
            tui.requestRender();
          }
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "70%",
        maxHeight: "40%",
        margin: 2,
      },
    },
  );

  if (taskError) {
    throw taskError;
  }

  return result;
}

function startHandoffPromptAfterSessionRender(
  ctx: HandoffPromptContext,
  approvedDraft: string,
): void {
  // ctx.newSession() renders the replacement session only after withSession returns.
  setImmediate(() => {
    void (async () => {
      try {
        await ctx.sendUserMessage(approvedDraft);
        ctx.ui.notify("Handoff started in a new session.", "info");
      } catch (error) {
        ctx.ui.notify(formatHandoffError(error), "error");
      }
    })();
  });
}

function formatHandoffError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "Handoff generation failed.";
}

function parseHandoffCommandArgs(
  args: string,
):
  | { kind: "ok"; goal: string; splitDirection?: HandoffSplitDirection | undefined }
  | { kind: "error"; message: string } {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return { kind: "error", message: HANDOFF_USAGE };
  }

  const directionFlags = new Map<string, HandoffSplitDirection>([
    ["--left", "left"],
    ["--right", "right"],
    ["--up", "up"],
    ["--down", "down"],
  ]);

  let splitDirection: HandoffSplitDirection | undefined;
  const goalTokens: string[] = [];

  for (const token of tokens) {
    const direction = directionFlags.get(token);
    if (!direction) {
      goalTokens.push(token);
      continue;
    }

    if (splitDirection) {
      return {
        kind: "error",
        message: "Use only one split flag: --left, --right, --up, or --down.",
      };
    }

    splitDirection = direction;
  }

  const goal = goalTokens.join(" ").trim();
  if (!goal) {
    return { kind: "error", message: HANDOFF_USAGE };
  }

  return {
    kind: "ok",
    goal,
    splitDirection,
  };
}
