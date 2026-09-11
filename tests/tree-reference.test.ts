import { expect, it } from "vitest";
import type { Card } from "../src/shared/types.js";
import { isCrossBranchReference, referenceCurve } from "../src/client/tree-reference.js";
const card = (id: string, parent: string | null, conversation = "session"): Card => ({ id, parent_card_id: parent, conversation_id: conversation, title: id, source_anchor_id: null, initial_snapshot_id: null, created_at: "2026-09-10" });
const cards = [card("root", null), card("a", "root"), card("a1", "a"), card("b", "root"), card("b1", "b")];
it("identifies cross-branch references in either direction", () => {
  expect(isCrossBranchReference(cards, "a", "b1")).toBe(true);
  expect(isCrossBranchReference(cards, "b1", "a1")).toBe(true);
});
it("does not animate self, ancestor, descendant, missing or cross-session targets", () => {
  for (const [from, to] of [["a", "a"], ["root", "b1"], ["b1", "root"], ["a", "a1"], ["a1", "a"], ["missing", "a"], ["a", "missing"]]) {
    expect(isCrossBranchReference(cards, from!, to!)).toBe(false);
  }
  expect(isCrossBranchReference([...cards, card("other", null, "another")], "a", "other")).toBe(false);
});
it("terminates on malformed cyclic ancestry", () => {
  expect(isCrossBranchReference([card("x", "y"), card("y", "x"), card("z", null)], "x", "z")).toBe(true);
});
it("curves from the exact source to target and handles coincident endpoints", () => {
  expect(referenceCurve({ x: 10, y: 20 }, { x: 90, y: 20 })).toBe("M 10 20 Q 50 40 90 20");
  expect(referenceCurve({ x: 10, y: 20 }, { x: 10, y: 20 })).not.toMatch(/NaN|Infinity/);
});
