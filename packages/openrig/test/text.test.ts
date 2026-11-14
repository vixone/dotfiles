import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dropBlank, dropPiDocs } from "../src/text.ts";

describe("dropBlank", () => {
  const required = ["path", "newText"];
  it("drops blank optional strings", () => {
    assert.deepEqual(dropBlank({ path: "a", newText: "x", namespace: "", allNamespaces: true }, required), { path: "a", newText: "x", allNamespaces: true });
    assert.deepEqual(dropBlank({ path: "a", newText: "x", namespace: "  " }, required), { path: "a", newText: "x" });
  });
  it("keeps required blanks, such as an fs_edit deletion", () => {
    assert.deepEqual(dropBlank({ path: "a", newText: "" }, required), { path: "a", newText: "" });
  });
});

describe("dropPiDocs", () => {
  const docs = "<docs>\nPi documentation (read only when...):\n- Main documentation: /x/README.md\n</docs>";
  it("removes Pi's docs block and keeps the text around it", () => {
    assert.equal(dropPiDocs(`<rules>\n- a\n</rules>\n\n${docs}\n\n<addendum>\nb`), "<rules>\n- a\n</rules>\n\n<addendum>\nb");
  });
  it("leaves a prompt without the block, or with another docs tag, alone", () => {
    assert.equal(dropPiDocs("<rules>\n- a\n</rules>"), "<rules>\n- a\n</rules>");
    assert.equal(dropPiDocs("<docs>\nproject notes\n</docs>"), "<docs>\nproject notes\n</docs>");
  });
});
