import { describe, expect, it } from "vitest";
import { isTypingTarget } from "@/lib/useSlashFocus";

describe("isTypingTarget", () => {
  it("is true for the fields a slash should be typed into", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
  });

  it("is true for a contenteditable element whatever its tag", () => {
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(
      true,
    );
  });

  it("is false for ordinary elements and for no target", () => {
    expect(isTypingTarget({ tagName: "DIV" })).toBe(false);
    expect(isTypingTarget({ tagName: "BODY" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("matches the tag case-insensitively", () => {
    expect(isTypingTarget({ tagName: "input" })).toBe(true);
  });
});
