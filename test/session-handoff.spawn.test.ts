import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHandoffBootstrap,
  createHandoffSessionMetadata,
  HANDOFF_BOOTSTRAP_ENV,
  parseHandoffBootstrap,
} from "../extensions/session-handoff/metadata.js";
import {
  buildPiLaunchCommand,
  buildPiResumeCommand,
  createHandoffSession,
  launchSplitHandoffSession,
  validateSplitHandoffPrerequisites,
} from "../extensions/session-handoff/spawn.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TMUX;
});

describe("session handoff spawn helpers", () => {
  it("creates a child session file with parent lineage and optional title", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-sessions-handoff-spawn-"));

    const created = createHandoffSession({
      cwd: "/tmp/project",
      sessionDir,
      parentSessionFile: "/tmp/project/parent.jsonl",
      title: "Implement autocomplete",
    });

    const lines = readFileSync(created.sessionFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const header = JSON.parse(lines[0] ?? "{}");
    const sessionInfo = JSON.parse(lines[1] ?? "{}");

    expect(created.sessionId).toBe(header.id);
    expect(header).toMatchObject({
      type: "session",
      cwd: "/tmp/project",
      parentSession: "/tmp/project/parent.jsonl",
    });
    expect(sessionInfo).toMatchObject({
      type: "session_info",
      parentId: null,
      name: "Implement autocomplete",
    });
  });

  it("builds a resume command with the bootstrap env and full session id", () => {
    const bootstrap = createHandoffBootstrap("child-session-123", createMetadata());
    const resumeCommand = buildPiResumeCommand(
      "/tmp/sessions",
      "child-session-123",
      Buffer.from(JSON.stringify(bootstrap), "utf8").toString("base64"),
      "Implement autocomplete",
    );

    expect(resumeCommand).toContain(HANDOFF_BOOTSTRAP_ENV);
    expect(resumeCommand).toContain("child-session-123");
    expect(resumeCommand).toContain("--session-dir");
    expect(resumeCommand).toContain("--session-id");
    expect(resumeCommand).toContain("--name");
    expect(resumeCommand).toContain("Implement autocomplete");
  });

  it("builds a bootstrap-aware pi launch command without shell-specific wrappers", () => {
    const launchCommand = buildPiLaunchCommand(
      "/tmp/sessions",
      "child-session-123",
      "encoded-bootstrap",
      "Implement autocomplete",
    );

    expect(launchCommand).toContain(HANDOFF_BOOTSTRAP_ENV);
    expect(launchCommand).toContain("encoded-bootstrap");
    expect(launchCommand).not.toContain("/bin/zsh");
  });

  it("fails split preflight when the current session is not persisted", async () => {
    const pi = createPiApi();
    const ctx = {
      cwd: "/tmp/project",
      sessionManager: {
        getSessionFile() {
          return undefined;
        },
      },
    };

    await expect(validateSplitHandoffPrerequisites(pi as never, ctx as never)).resolves.toBe(
      "Split handoff requires a persisted current session.",
    );
  });

  it("fails split preflight outside tmux", async () => {
    // TMUX env not set
    const pi = createPiApi();
    const ctx = {
      cwd: "/tmp/project",
      sessionManager: {
        getSessionFile() {
          return "/tmp/project/current.jsonl";
        },
      },
    };

    await expect(validateSplitHandoffPrerequisites(pi as never, ctx as never)).resolves.toBe(
      "Split handoff requires running inside tmux.",
    );
  });

  it("passes split preflight when running inside tmux", async () => {
    process.env.TMUX = "/tmp/tmux-xxx/default,123,0";
    const pi = createPiApi();
    const ctx = {
      cwd: "/tmp/project",
      sessionManager: {
        getSessionFile() {
          return "/tmp/project/current.jsonl";
        },
      },
    };

    await expect(
      validateSplitHandoffPrerequisites(pi as never, ctx as never),
    ).resolves.toBeUndefined();
  });

  it("launches tmux split-window with pane id output", async () => {
    const pi = createPiApi({ code: 0 });
    const bootstrapValue = Buffer.from(
      JSON.stringify(createHandoffBootstrap("child-session-123", createMetadata())),
      "utf8",
    ).toString("base64");

    const result = await launchSplitHandoffSession(pi as never, {
      cwd: "/tmp/project",
      sessionDir: "/tmp/sessions",
      direction: "right",
      sessionId: "child-session-123",
      bootstrapValue,
      title: "Implement autocomplete",
    });

    expect(result).toEqual({ success: true });
    expect(pi.exec).toHaveBeenCalledWith("tmux", expect.any(Array), {
      cwd: "/tmp/project",
      timeout: 15_000,
    });

    const tmuxArgs = (pi.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
    expect(tmuxArgs[0]).toBe("split-window");
    expect(tmuxArgs).toContain("-h");
    expect(tmuxArgs).toContain("-P");
    expect(tmuxArgs).toContain("-F");
    expect(tmuxArgs).toContain("#{pane_id}");
    expect(tmuxArgs).not.toContain("-d");
    // The env var is inside the shell command (last arg), not a direct tmux arg
    const lastArg = tmuxArgs[tmuxArgs.length - 1] ?? "";
    expect(lastArg).toContain(HANDOFF_BOOTSTRAP_ENV);
    expect(lastArg).toContain("child-session-123");
    expect(lastArg).toContain("/tmp/sessions");
    expect(lastArg).toContain("Implement autocomplete");
  });

  it("maps left direction to horizontal before", async () => {
    const pi = createPiApi({ code: 0 });

    const result = await launchSplitHandoffSession(pi as never, {
      cwd: "/tmp/project",
      sessionDir: "/tmp/sessions",
      direction: "left",
      sessionId: "child-session-123",
      bootstrapValue: "encoded",
      title: "Title",
    });

    expect(result).toEqual({ success: true });
    const tmuxArgs = (pi.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
    expect(tmuxArgs).toContain("-h");
    expect(tmuxArgs).toContain("-b");
  });

  it("maps up direction to vertical before", async () => {
    const pi = createPiApi({ code: 0 });

    const result = await launchSplitHandoffSession(pi as never, {
      cwd: "/tmp/project",
      sessionDir: "/tmp/sessions",
      direction: "up",
      sessionId: "child-session-123",
      bootstrapValue: "encoded",
      title: "Title",
    });

    expect(result).toEqual({ success: true });
    const tmuxArgs = (pi.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
    expect(tmuxArgs).toContain("-v");
    expect(tmuxArgs).toContain("-b");
  });

  it("maps down direction to vertical default", async () => {
    const pi = createPiApi({ code: 0 });

    const result = await launchSplitHandoffSession(pi as never, {
      cwd: "/tmp/project",
      sessionDir: "/tmp/sessions",
      direction: "down",
      sessionId: "child-session-123",
      bootstrapValue: "encoded",
      title: "Title",
    });

    expect(result).toEqual({ success: true });
    const tmuxArgs = (pi.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
    expect(tmuxArgs).toContain("-v");
    expect(tmuxArgs).not.toContain("-b");
  });

  it("reports tmux launch failures with a tmux hint", async () => {
    const pi = createPiApi({ code: 1, stderr: "error: can't connect to tmux" });

    const result = await launchSplitHandoffSession(pi as never, {
      cwd: "/tmp/project",
      sessionDir: "/tmp/sessions",
      direction: "right",
      sessionId: "child-session-123",
      bootstrapValue: "encoded-bootstrap",
      title: "Implement autocomplete",
    });

    expect(result).toEqual({
      success: false,
      error:
        "Failed to launch tmux split: error: can't connect to tmux. " +
        "Split handoff requires running inside tmux.",
    });
  });

  it("keeps bootstrap payloads decodable after encoding", () => {
    const bootstrapValue = Buffer.from(
      JSON.stringify(createHandoffBootstrap("child-session-123", createMetadata())),
      "utf8",
    ).toString("base64");

    expect(parseHandoffBootstrap(bootstrapValue)).toEqual({
      sessionId: "child-session-123",
      goal: "Finish phase 1",
      nextTask: "Implement autocomplete",
      title: "Implement autocomplete",
      initialPrompt: "Approved handoff draft",
    });
  });
});

function createPiApi(result?: { code?: number; stdout?: string; stderr?: string }): ExtensionAPI {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(),
    setLabel: vi.fn(),
    exec: vi.fn().mockResolvedValue({
      stdout: result?.stdout ?? "",
      stderr: result?.stderr ?? "",
      code: result?.code ?? 0,
      killed: false,
    }),
    getActiveTools: vi.fn(),
    getAllTools: vi.fn(),
    setActiveTools: vi.fn(),
    getCommands: vi.fn(),
    setModel: vi.fn(),
    getThinkingLevel: vi.fn(),
    setThinkingLevel: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    events: {
      emit: vi.fn(),
      on: vi.fn().mockReturnValue(() => {}),
    },
  };
}

function createMetadata() {
  return createHandoffSessionMetadata(
    "Finish phase 1",
    "Implement autocomplete",
    "Approved handoff draft",
    "Implement autocomplete",
  );
}
