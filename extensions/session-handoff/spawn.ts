import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionHeader,
  type SessionInfoEntry,
} from "@earendil-works/pi-coding-agent";
import { HANDOFF_BOOTSTRAP_ENV } from "./metadata.js";

const TMUX_SPLIT_TIMEOUT_MS = 15_000;

export type HandoffSplitDirection = "left" | "right" | "up" | "down";

export interface CreatedHandoffSession {
  sessionId: string;
  sessionFile: string;
}

export async function validateSplitHandoffPrerequisites(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  if (!ctx.sessionManager.getSessionFile()) {
    return "Split handoff requires a persisted current session.";
  }

  if (!process.env.TMUX) {
    return "Split handoff requires running inside tmux.";
  }

  return undefined;
}

export function createHandoffSession(options: {
  cwd: string;
  sessionDir: string;
  parentSessionFile: string;
  title: string;
}): CreatedHandoffSession {
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const sessionFile = join(options.sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);

  const header: SessionHeader = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: options.cwd,
    parentSession: options.parentSessionFile,
  };

  const titleEntry: SessionInfoEntry = {
    type: "session_info",
    id: randomUUID(),
    parentId: null,
    timestamp,
    name: options.title,
  };

  writeFileSync(
    sessionFile,
    `${[JSON.stringify(header), JSON.stringify(titleEntry)].join("\n")}\n`,
  );

  return { sessionId, sessionFile };
}

export async function launchSplitHandoffSession(
  pi: ExtensionAPI,
  options: {
    cwd: string;
    sessionDir: string;
    direction: HandoffSplitDirection;
    sessionId: string;
    bootstrapValue: string;
    title: string;
  },
): Promise<{ success: true } | { success: false; error: string }> {
  const piCommand = buildPiLaunchCommand(
    options.sessionDir,
    options.sessionId,
    options.bootstrapValue,
    options.title,
  );

  const tmuxDirectionFlag =
    options.direction === "left" || options.direction === "right" ? "-h" : "-v";
  const tmuxBeforeFlag =
    options.direction === "left" || options.direction === "up" ? "-b" : undefined;

  const tmuxArgs = [
    "split-window",
    tmuxDirectionFlag,
    ...(tmuxBeforeFlag ? [tmuxBeforeFlag] : []),
    "-P",
    "-F",
    "#{pane_id}",
    "-c",
    options.cwd,
    piCommand,
  ];

  const result = await pi.exec("tmux", tmuxArgs, {
    cwd: options.cwd,
    timeout: TMUX_SPLIT_TIMEOUT_MS,
  });

  if (result.code === 0) {
    return { success: true };
  }

  const details = `${result.stderr || result.stdout}`.trim() || `exit code ${result.code}`;
  return {
    success: false,
    error: `Failed to launch tmux split: ${details}. Split handoff requires running inside tmux.`,
  };
}

export function buildPiResumeCommand(
  sessionDir: string,
  sessionId: string,
  bootstrapValue: string,
  title: string,
): string {
  const args = [
    `${HANDOFF_BOOTSTRAP_ENV}=${shellQuote(bootstrapValue)}`,
    "pi",
    "--session-dir",
    shellQuote(sessionDir),
    "--session-id",
    shellQuote(sessionId),
    "--name",
    shellQuote(title),
  ];

  return args.join(" ");
}

export function buildPiLaunchCommand(
  sessionDir: string,
  sessionId: string,
  bootstrapValue: string,
  title: string,
): string {
  return buildPiResumeCommand(sessionDir, sessionId, bootstrapValue, title);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
