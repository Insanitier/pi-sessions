import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function isTuiMode(ctx: Pick<ExtensionContext, "mode">): boolean {
  return ctx.mode === "tui";
}
