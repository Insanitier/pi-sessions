import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleHandoffDraft,
  buildExtractionPrompt,
  extractHandoffContext,
  generateHandoffDraft,
} from "../extensions/session-handoff/extract.js";

const { completeSimpleMock } = vi.hoisted(() => ({
  completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async () => {
  const actual = await vi.importActual<object>("@earendil-works/pi-ai");
  return {
    ...actual,
    completeSimple: completeSimpleMock,
  };
});

afterEach(() => {
  completeSimpleMock.mockReset();
});

describe("session handoff extraction", () => {
  it("assembles the draft in the expected order and omits empty sections", () => {
    const draft = assembleHandoffDraft(
      "session-123",
      "/tmp/session.jsonl",
      {
        title: "Implement handoff command",
        summary: "Relevant context only.",
        relevantFiles: ["src/index.ts", "README.md"],
        nextTask: "Implement the command.",
        openQuestions: [],
      },
      "Ignored fallback goal",
    );

    expect(draft).toContain(
      "Continuing work from session session-123. When you lack specific information you can use session_ask.",
    );
    expect(draft).not.toContain("/tmp/session.jsonl");
    expect(draft.indexOf("## Task")).toBeLessThan(draft.indexOf("## Relevant Files"));
    expect(draft.indexOf("## Relevant Files")).toBeLessThan(draft.indexOf("## Context"));
    expect(draft).not.toContain("## Open Questions");
  });

  it("extracts and normalizes structured tool-call arguments", () => {
    const extraction = extractHandoffContext(
      {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 0,
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "create_handoff_context",
            arguments: {
              title: "  Implement handoff command  ",
              summary: "  Keep this.  ",
              relevantFiles: [" src/index.ts ", "src/index.ts", "", 1],
              nextTask: "  Implement the command. ",
              openQuestions: [" Should tests cover cancel? ", "", null],
            },
          },
        ],
      },
      "fallback goal",
    );

    expect(extraction).toEqual({
      context: {
        title: "Implement handoff command",
        summary: "Keep this.",
        relevantFiles: ["src/index.ts"],
        nextTask: "Implement the command.",
        openQuestions: ["Should tests cover cancel?"],
      },
    });
  });

  it("builds a draft from a structured tool call", async () => {
    completeSimpleMock.mockResolvedValue({
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "create_handoff_context",
          arguments: {
            title: "Finish handoff phase 1",
            summary: "The command is partly implemented.",
            relevantFiles: ["extensions/session-handoff.ts"],
            nextTask: "Finish phase 1 and verify it.",
            openQuestions: ["Should the preview use an overlay?"],
          },
        },
      ],
    });

    const result = await generateHandoffDraft(
      createGenerationContext(),
      "Finish phase 1.",
      "medium",
    );

    expect(result?.sessionId).toBe("session-123");
    expect(result?.context.title).toBe("Finish handoff phase 1");
    expect(result?.draft).toContain("## Task\nFinish phase 1 and verify it.");
    expect(result?.draft).toContain("## Relevant Files\n- extensions/session-handoff.ts");
    expect(result?.draft).toContain("## Context\nThe command is partly implemented.");
    expect(result?.draft).toContain("## Open Questions\n- Should the preview use an overlay?");

    const [model, context, options] = completeSimpleMock.mock.calls[0] ?? [];
    expect(model).toEqual({ provider: "openai", id: "gpt-5.4", reasoning: true });
    expect(context.tools).toHaveLength(1);
    expect(options).toMatchObject({ apiKey: "test-key", reasoning: "medium" });
    expect(options).not.toHaveProperty("toolChoice");
  });

  it("rejects generated titles longer than 64 characters", async () => {
    completeSimpleMock.mockResolvedValue({
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "create_handoff_context",
          arguments: {
            title:
              "This generated handoff title is intentionally much longer than sixty four characters",
            summary: "The command is partly implemented.",
            relevantFiles: [],
            nextTask: "Finish phase 1 and verify it.",
          },
        },
      ],
    });

    await expect(
      generateHandoffDraft(createGenerationContext(), "Finish phase 1.", "medium"),
    ).rejects.toThrow("Handoff title must be 64 characters or less.");
  });

  it("rejects responses without the structured tool call", async () => {
    completeSimpleMock.mockResolvedValue({
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "I forgot the tool call." }],
    });

    await expect(
      generateHandoffDraft(createGenerationContext(), "Finish phase 1.", "medium"),
    ).rejects.toThrow("Handoff extraction did not return structured context.");
  });

  it("includes the goal and conversation in the extraction prompt", () => {
    const prompt = buildExtractionPrompt("user: hello", "Finish phase 1.");

    expect(prompt).toContain("## Conversation\nuser: hello");
    expect(prompt).toContain("## Goal\nFinish phase 1.");
    expect(prompt).toContain("Call create_handoff_context exactly once.");
  });
});

function createGenerationContext() {
  return {
    model: { provider: "openai", id: "gpt-5.4", reasoning: true },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "test-key", headers: undefined };
      },
    },
    sessionManager: {
      getEntries() {
        return [
          {
            type: "message",
            id: "user-1",
            parentId: null,
            timestamp: "2026-03-23T00:00:00.000Z",
            message: {
              role: "user",
              content: [{ type: "text", text: "Please implement phase 1." }],
              timestamp: 1,
            },
          },
        ];
      },
      getLeafId() {
        return "user-1";
      },
      getSessionId() {
        return "session-123";
      },
      getSessionFile() {
        return "/tmp/session.jsonl";
      },
    },
  } as never;
}
