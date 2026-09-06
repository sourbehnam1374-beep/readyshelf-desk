/**
 * Success: run edit → Approve → publish 3 times.
 * Zero unapproved publishes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { freezePost, resolvePublishText } from "../lib/trust.js";

function readyPost(i) {
  return {
    id: `post_${i}`,
    source_id: `src_${i}`,
    status: "ready",
    draft_text: `Tip: fact ${i} from source.`,
  };
}

test("3 approved publishes; 0 unapproved", () => {
  const published = [];
  const blocked = [];

  for (let i = 1; i <= 3; i++) {
    const edited = `Tip: fact ${i} from source.\n\nEdited ${i}.`;
    const frozen = freezePost(readyPost(i), edited);
    const { text, post } = resolvePublishText([frozen], { postId: frozen.id, text: edited });
    assert.equal(text, edited);
    assert.equal(post.status, "frozen");
    published.push({ postId: post.id, text, link: `https://t.me/readyshelf/${1000 + i}` });
  }
  assert.equal(published.length, 3);

  const sneak = [
    () => resolvePublishText([readyPost(9)], { postId: "post_9", text: "sneak" }),
    () => resolvePublishText([], { text: "unapproved blast" }),
    () => resolvePublishText([{ id: "x", status: "ready", draft_text: "x" }], { postId: "x" }),
    () =>
      resolvePublishText(
        [{ id: "f", status: "frozen", frozen_text: "A" }],
        { postId: "f", text: "B" },
      ),
  ];
  for (const fn of sneak) {
    try {
      fn();
      assert.fail("unapproved publish must not succeed");
    } catch (err) {
      assert.ok(err.status === 409 || err.status === 400);
      blocked.push(err.message);
    }
  }
  assert.equal(blocked.length, sneak.length);
  assert.equal(published.length, 3);
});
