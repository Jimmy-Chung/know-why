import { expect, it } from "vitest";
import type { Card } from "../src/shared/types.js";
import { buildTreeGeometry, treeFrameSize, treeSurface, treeClippedEdges } from "../src/client/tree-geometry.js";
const card = (id: string, parent: string | null): Card => ({ id, parent_card_id: parent, conversation_id: "fixture", title: id, source_anchor_id: null, initial_snapshot_id: null, created_at: "2026-09-09" });

it("keeps the frame landscape and within the content area for small, tall and wide trees", () => {
  for (const graph of [{ width: 0, height: 0 }, { width: 168, height: 128 }, { width: 0, height: 1600 }, { width: 6000, height: 1600 }]) {
    for (const available of [{ width: 900, height: 700 }, { width: 340, height: 500 }, { width: 500, height: 180 }]) {
      const frame = treeFrameSize(graph, available.width, available.height);
      expect(frame.width).toBeGreaterThan(frame.height);
      expect(frame.width).toBeLessThanOrEqual(available.width - 48);
      expect(frame.height).toBeLessThanOrEqual(available.height - 48);
    }
  }
  expect(treeFrameSize({ width: 168, height: 128 }, 900, 700)).toEqual({ width: 280, height: 224 });
});

it("preserves every branch, parent-above-child geometry and sibling order", () => {
  const cards = [card("root", null), card("a", "root"), card("b", "root"), card("a1", "a"), card("a2", "a")];
  const graph = buildTreeGeometry(cards);
  const byId = new Map(graph.nodes.map(n => [n.card.id, n]));
  expect(graph.nodes).toHaveLength(cards.length);
  expect(byId.get("a")!.y).toBe(byId.get("b")!.y);
  expect(byId.get("root")!.y).toBeLessThan(byId.get("a")!.y);
  expect(byId.get("a")!.x).toBe((byId.get("a1")!.x + byId.get("a2")!.x) / 2);
  expect(byId.get("a")!.x).toBeLessThan(byId.get("b")!.x);
});
it("can center even the outermost branch in the compact viewport without shrinking nodes", () => {
  const graph = buildTreeGeometry([card("root", null), ...Array.from({ length: 40 }, (_, i) => card(`c${i}`, "root"))]);
  for (const width of [64, 176]) for (const zoom of [0.5, 1, 2]) {
    const surface = treeSurface(graph, width, 500, true, zoom);
    for (const node of graph.nodes) {
      const idealScroll = surface.offsetX + node.x * zoom - width / 2;
      expect(idealScroll).toBeGreaterThanOrEqual(0);
      expect(idealScroll).toBeLessThanOrEqual(surface.width - width);
      const verticalScroll = surface.offsetY + node.y * zoom - 250;
      expect(verticalScroll).toBeGreaterThanOrEqual(0);
      expect(verticalScroll).toBeLessThanOrEqual(surface.height - 500);
    }
  }
});
it("shows frosting only where actual graph content is clipped, not in blank centering space", () => {
  expect(treeClippedEdges({ width: 0, height: 0 }, 88, { width: 176, height: 500, left: 0, top: 0 })).toEqual({ left: false, right: false, top: false, bottom: false });
  expect(treeClippedEdges({ width: 500, height: 900 }, 88, { width: 176, height: 500, left: 200, top: 250 })).toEqual({ left: true, right: true, top: true, bottom: true });
});
it("handles an empty tree", () => {
  expect(buildTreeGeometry([])).toEqual({ nodes: [], width: 0, height: 0 });
});
