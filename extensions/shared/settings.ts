import os from "node:os";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { parseTypeBoxValue } from "./typebox.js";

export const DEFAULT_AUTO_TITLE_REFRESH_TURNS = 4;
export const DEFAULT_AUTO_TITLE_PROMPT = `You generate concrete coding session titles from the conversation provided.

Return title text only.

Rules:
- Prefer 3-15 words.
- Maximum 120 characters.
- Use the full conversation, while letting the most recent work refine the title when needed.
- Describe the current task, bug, feature, or investigation on the active branch.
- Mention specific subsystem or file only when it improves clarity.
- No quotes, markdown, emojis, prefixes, or explanations.
- No trailing punctuation.
- Avoid generic titles like Coding help or Working on project.`;
const SESSION_FILE_SETTINGS_SCHEMA = Type.Object({
  handoff: Type.Optional(
    Type.Object({
      pickerShortcut: Type.Optional(Type.String()),
    }),
  ),
  index: Type.Optional(
    Type.Object({
      dir: Type.Optional(Type.String()),
    }),
  ),
  autoTitle: Type.Optional(
    Type.Object({
      refreshTurns: Type.Optional(Type.Integer({ minimum: 1 })),
      model: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
    }),
  ),
});
const ROOT_SETTINGS_SCHEMA = Type.Object({
  sessions: Type.Optional(SESSION_FILE_SETTINGS_SCHEMA),
});

export class ModelReference {
  constructor(
    readonly provider: string,
    readonly modelId: string,
  ) {}

  toString(): string {
    return `${this.provider}/${this.modelId}`;
  }
}

export interface AutoTitleSettings {
  refreshTurns: number;
  model: ModelReference | undefined;
  prompt: string;
}

export interface SessionSettings {
  handoff: {
    pickerShortcut: KeyId;
  };
  index: {
    path: string;
  };
  autoTitle: AutoTitleSettings;
}

type SessionFileSettings = Static<typeof SESSION_FILE_SETTINGS_SCHEMA>;

export function getDefaultIndexDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "pi-sessions");
}

export function getDefaultIndexPath(): string {
  return path.join(getDefaultIndexDir(), "index.sqlite");
}

function expandHome(rawPath: string): string {
  if (rawPath === "~") {
    return os.homedir();
  }

  if (rawPath.startsWith(`~${path.sep}`) || rawPath.startsWith("~/")) {
    return path.join(os.homedir(), rawPath.slice(2));
  }

  return rawPath;
}

function normalizeIndexDir(value: string | undefined): string {
  if (value === undefined) {
    return getDefaultIndexDir();
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return getDefaultIndexDir();
  }

  const expanded = expandHome(trimmed);
  if (!path.isAbsolute(expanded)) {
    throw new Error('sessions.index.dir must be an absolute path or start with "~/".');
  }

  return path.normalize(expanded);
}

function normalizePickerShortcut(value: string | undefined): KeyId {
  const trimmed = value?.trim();
  return (trimmed ? trimmed : "alt+o") as KeyId;
}

function parseModelReference(value: string | undefined): ModelReference | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return undefined;
  }

  return new ModelReference(trimmed.slice(0, slashIndex), trimmed.slice(slashIndex + 1));
}

function normalizeAutoTitlePrompt(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : DEFAULT_AUTO_TITLE_PROMPT;
}

function loadSessionFileSettings(): SessionFileSettings {
  const globalSettings = SettingsManager.create(process.cwd()).getGlobalSettings();
  const parsed = parseTypeBoxValue(ROOT_SETTINGS_SCHEMA, globalSettings, "Invalid settings");
  return parsed.sessions ?? {};
}

function resolveSessionSettings(fileSettings: SessionFileSettings): SessionSettings {
  const indexDir = normalizeIndexDir(fileSettings.index?.dir);

  return {
    handoff: {
      pickerShortcut: normalizePickerShortcut(fileSettings.handoff?.pickerShortcut),
    },
    index: {
      path: path.join(indexDir, "index.sqlite"),
    },
    autoTitle: {
      refreshTurns: fileSettings.autoTitle?.refreshTurns ?? DEFAULT_AUTO_TITLE_REFRESH_TURNS,
      model: parseModelReference(fileSettings.autoTitle?.model),
      prompt: normalizeAutoTitlePrompt(fileSettings.autoTitle?.prompt),
    },
  };
}

export function loadSettings(): SessionSettings {
  return resolveSessionSettings(loadSessionFileSettings());
}
