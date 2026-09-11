// Disposable visual/interaction fixture. Reuses the local fake provider; no user data or API keys.
import assert from 'node:assert/strict';
import { join } from 'node:path';
const { fixtureDataDir } = await import('./preview-rag.js');
const { getDb } = await import('../src/server/db.js');
// Fail closed before any visual fixture mutations if the DB is not our fresh temp DB.
assert.equal(getDb().name, join(fixtureDataDir, 'know-know.sqlite'));
const repo = await import('../src/server/repo.js');
const conv = repo.conversations.list()[0]!;
const main = repo.cards.listForConversation(conv.id).find(c => !c.parent_card_id)!;
repo.conversations.rename(conv.id, '从科幻电影，探索城市与人的关系');
repo.conversations.lock(conv.id);
const add = (cardId: string, role: 'user' | 'assistant', content: string) => repo.messages.create({ conversation_id: conv.id, card_id: cardId, role, content, plaintext: content, status: 'complete' });
add(main.id, 'user', '电影中的未来城市，为什么总是让人感到孤独？');
const answer = add(main.id, 'assistant', '## 从城市开始，理解赛博朋克\n\n赛博朋克是一类科幻表达。它把高度发展的技术与普通人的生活并置：霓虹灯、巨大的建筑、密集的人群，以及人与人之间的距离。\n\n### 两条值得继续探索的线索\n\n- **城市空间**：建筑与街道如何影响人物的行动？\n- **身份与记忆**：当技术能够改变身体，我们如何认识自己？\n\n> 可以从一个具体的概念出发，再回到电影的整体表达。');
function branch(parent: typeof main, source: typeof answer, title: string) {
  const offset = source.content.indexOf(title);
  const anchor = repo.anchors.create({ conversation_id: conv.id, card_id: parent.id, source_message_id: source.id, source_message_version: 1, selected_text: title, start_offset: Math.max(0, offset), end_offset: Math.max(0, offset) + title.length, prefix: '', suffix: '' });
  const snapshot = repo.snapshots.create({ conversation_id: conv.id, card_id: parent.id, message_refs: [source.id], fork_boundary_message_id: source.id });
  const card = repo.cards.createBranch({ conversation_id: conv.id, parent_card_id: parent.id, source_anchor_id: anchor.id, initial_snapshot_id: snapshot.id, title });
  repo.anchors.setBranch(anchor.id, card.id);
  return card;
}
const cyber = branch(main, answer, '赛博朋克');
add(cyber.id, 'user', '我想进一步理解赛博朋克的视觉表达。');
const detail = add(cyber.id, 'assistant', '## 在繁华与疏离之间\n\n赛博朋克不只是霓虹色的画面。它通过城市的尺度、光线和空间关系，让观众感受到技术发展与个体生活之间的张力。\n\n### 三种常见的视觉语言\n\n| 视觉元素 | 表达方式 | 带来的感受 |\n| --- | --- | --- |\n| 巨型建筑 | 人物被放在画面的边缘 | 个体的渺小 |\n| 层叠街道 | 不同生活空间互相交错 | 秩序与混乱并存 |\n| 人工光源 | 冷暖光线切割人物轮廓 | 繁华中的孤独 |\n\n**城市空间**是其中一条线索；另一条是**身份与记忆**。人物面对的不只是外部世界，也包括“我是谁”这个问题。\n\n> 技术越发达，关于人的提问反而越清晰。');
const city = branch(cyber, detail, '城市空间');
add(city.id, 'user', '城市空间如何影响叙事？');
add(city.id, 'assistant', '城市空间可以通过尺度、距离与动线影响叙事。\n\n我们可以观察人物从哪里出发，能去哪里，以及哪些空间无法进入。');
const identity = branch(cyber, detail, '身份与记忆');
const identityAnswer = add(identity.id, 'assistant', '身份与记忆涉及人物如何理解自己的过去，以及如何判断自身经验的真实性。');
branch(main, answer, '身份与记忆');
repo.viewState.upsert(conv.id, cyber.id, 0);
repo.assistant.add({ conversation_id: conv.id, thread_id: 'visual-review', role: 'user', content: '帮我串联一下刚才探索的内容。', evidence: [] });
repo.assistant.add({ conversation_id: conv.id, thread_id: 'visual-review', role: 'assistant', content: '我们从电影里的未来城市出发，逐渐走向两个方向。\n\n### 城市与个体\n\n赛博朋克通过建筑尺度、光线和街道的层次，呈现个体与技术环境之间的关系。[1]\n\n### 身份与记忆\n\n另一个分支讨论人物如何认识自己的经历。这两条线索最终都指向同一个问题：**在技术不断变化的环境中，人如何理解自己？**[2]', evidence: [{ card_id: cyber.id, message_id: detail.id }, { card_id: identity.id, message_id: identityAnswer.id }] });
console.log('UI fixture seeded with branches, markdown and assistant history.');

// Optional real term-navigation fixture; all writes remain in the asserted temporary DB.
if (process.env.KK_PREVIEW_REFERENCE === '1') {
  repo.termLinks.upsertFirst({ conversation_id: conv.id, term_text: '城市空间', first_card_id: city.id, first_anchor_id: city.source_anchor_id! });
  repo.termLinks.upsertFirst({ conversation_id: conv.id, term_text: '身份与记忆', first_card_id: identity.id, first_anchor_id: identity.source_anchor_id! });
  add(identity.id, 'assistant', '城市空间也会影响人物对身份的认识。');
  add(city.id, 'assistant', '身份与记忆是理解人物经历的另一条线索。');
  repo.viewState.upsert(conv.id, identity.id, 0);
}

// Optional dense-tree fixture, still within the fresh temporary database above.
if (process.env.KK_PREVIEW_DENSE_TREE === '1') {
  for (let i = 1; i <= 24; i++) {
    const topic = branch(main, answer, `扩展主题 ${i}`);
    const source = add(topic.id, 'assistant', '子方向 A、子方向 B、子方向 C');
    for (const name of ['子方向 A', '子方向 B', '子方向 C']) branch(topic, source, name);
  }
  let deep = cyber;
  for (let i = 1; i <= 14; i++) {
    const source = add(deep.id, 'assistant', `深入探索 ${i}`);
    deep = branch(deep, source, `深入探索 ${i}`);
  }
  repo.viewState.upsert(conv.id, deep.id, 0);
  console.log('Dense-tree fixture ready: more than 100 cards with a deep active path.');
}
