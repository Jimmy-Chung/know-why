import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candidate } from "../src/server/knowledge.js";
import type { KnowledgeAssistantMessage } from "../src/shared/types.js";

const mocks=vi.hoisted(()=>({available:true, embeds:vi.fn(), query:vi.fn()}));
vi.mock("../src/server/embedding.js",async original=>({...(await original<any>()),embeddingAvailable:async()=>mocks.available,embed:mocks.embeds,embedQuery:mocks.query}));
let repo:typeof import("../src/server/repo.js");
let knowledge:typeof import("../src/server/knowledge.js");
let rag:typeof import("../src/server/rag.js");
let db:ReturnType<typeof import("../src/server/db.js")["getDb"]>;
beforeAll(async()=>{
  process.env.KNOW_KNOW_DATA_DIR=mkdtempSync(join(tmpdir(),"kk-rag-"));
  (await import("../src/server/migrate.js")).runMigrations();
  repo=await import("../src/server/repo.js");knowledge=await import("../src/server/knowledge.js");rag=await import("../src/server/rag.js");
  db=(await import("../src/server/db.js")).getDb();
});
const vector=(s:string)=>new Float32Array(s.includes("光合作用") || s.includes("制造养分")?[1,0]:[0,1]);
beforeEach(()=>{mocks.available=true;mocks.embeds.mockReset().mockImplementation(async(texts:string[])=>texts.map(vector));mocks.query.mockReset().mockImplementation(async(s:string)=>vector(s));});
function setup(){
  const p=repo.providers.create({type:"custom",name:"test",api_base:"http://127.0.0.1:1",default_model:"test",is_default:false,capabilities:{web_search:false,thinking:false,tool_calls:false,force_search:false,models:[],context_window:32000},secret_ref:"",has_secret:false});
  const conv=repo.conversations.create(p,"test","off","default");const card=repo.cards.createMain(conv.id);return {conv,card};
}
function message(c:ReturnType<typeof setup>,text:string,role:"user"|"assistant"|"system"="assistant",status:any="complete"){
  return repo.messages.create({conversation_id:c.conv.id,card_id:c.card.id,role,content:text,plaintext:text,status});
}
function branch(c:ReturnType<typeof setup>,title:string){
  const card=repo.cards.createBranch({conversation_id:c.conv.id,parent_card_id:c.card.id,title,source_anchor_id:null as any,initial_snapshot_id:"pending"});return {conv:c.conv,card};
}
const rows=(conv:string)=>db.prepare("SELECT * FROM knowledge_passage WHERE conversation_id=? ORDER BY id").all(conv) as any[];

describe("RAG passage retrieval and index consistency",()=>{
  it("excludes all passages and cached semantic hits, keeps chat text, and restores knowledge", async () => {
    const c=setup(); const m=message(c,"光合作用的旧结论。\n\n"+"光合作用背景。".repeat(300));
    await knowledge.indexEmbeddings(c.conv.id);
    await knowledge.retrievePassages(c.conv.id,"光合作用");
    expect((await knowledge.retrievePassages(c.conv.id,"光合作用")).cacheHit).toBe(true);
    repo.messages.setKnowledgeExcluded(m.id,true);
    expect((await knowledge.retrievePassages(c.conv.id,"光合作用")).candidates).toEqual([]);
    expect(rows(c.conv.id)).toEqual([]);
    expect(repo.messages.get(m.id)?.content).toBe(m.content);
    expect(repo.messages.get(m.id)?.knowledge_excluded).toBe(true);
    repo.messages.setKnowledgeExcluded(m.id,false);
    expect((await knowledge.retrievePassages(c.conv.id,"光合作用")).candidates.map(p=>p.messageId)).toContain(m.id);
  });
  it("does not reuse old assistant turns after knowledge changes, but keeps their history visible", () => {
    const c=setup(); const m=message(c,"错误信息");
    repo.assistant.add({conversation_id:c.conv.id,role:"user",content:"原问题",evidence:[]});
    repo.assistant.add({conversation_id:c.conv.id,role:"assistant",content:"错误信息",evidence:[]});
    repo.messages.setKnowledgeExcluded(m.id,true);
    const next=repo.assistant.add({conversation_id:c.conv.id,role:"user",content:"纠正后呢",evidence:[]});
    expect(repo.assistant.list(c.conv.id)).toHaveLength(3);
    expect(rag.assistantHistory(repo.assistant.list(c.conv.id),null,next.id)).toEqual([]);
    repo.assistant.add({conversation_id:c.conv.id,role:"assistant",content:"新答案",evidence:[]});
    const followup=repo.assistant.add({conversation_id:c.conv.id,role:"user",content:"继续",evidence:[]});
    expect(rag.assistantHistory(repo.assistant.list(c.conv.id),null,followup.id).map(m=>m.content)).toEqual(["纠正后呢","新答案"]);
  });
  it("discards a passage excluded while query embedding is in flight",async()=>{
    const c=setup();const m=message(c,"光合作用旧内容");await knowledge.indexEmbeddings(c.conv.id);
    mocks.query.mockImplementationOnce(async()=>{repo.messages.setKnowledgeExcluded(m.id,true);return vector("光合作用");});
    expect((await knowledge.retrievePassages(c.conv.id,"光合作用")).candidates).toEqual([]);
  });
  it("finds a fact past the old 800-character cutoff and retains its question and offsets",async()=>{
    mocks.available=false;const c=setup();message(c,"介绍项目限制","user");
    const body="普通背景。".repeat(300)+"\n\n特殊限制：星桥协议仅支持离线运行。";
    const m=message(c,body);const result=await knowledge.searchInSession(c.conv.id,"星桥协议");
    const hit=result.find(r=>r.messageId===m.id && r.text.includes("星桥协议"))!;
    expect(hit.startOffset).toBeGreaterThan(800);expect(hit.question).toBe("介绍项目限制");expect(body.slice(hit.startOffset,hit.endOffset)).toBe(hit.text);
  });
  it("keeps multiple relevant messages from the same card and groups only citations",async()=>{
    mocks.available=false;const c=setup();message(c,"星桥协议支持离线。");message(c,"星桥协议不支持在线。");
    const found=await knowledge.searchInSession(c.conv.id,"星桥协议");const request=rag.buildRagRequest("星桥协议的限制",[],found,32000);
    expect(request.evidence).toHaveLength(1);expect(request.evidence[0]!.excerpts).toHaveLength(2);
    expect(request.messages.at(-1)!.content).toContain("不支持在线");
  });
  it("semantic hits compete even when lexical results are full",async()=>{
    const c=setup();for(let i=0;i<15;i++)message(c,`植物展示区编号 ${i}，不涉及生物过程。`);
    const relevant=message(c,"光合作用将光能转化为化学能。");await knowledge.indexEmbeddings(c.conv.id);
    const found=await knowledge.searchInSession(c.conv.id,"植物如何制造养分",12);
    expect(found.map(r=>r.messageId)).toContain(relevant.id);
  });
  it("excludes unfinished, failed and system summary messages",async()=>{
    mocks.available=false;const c=setup();message(c,"排除词系统摘要","system");message(c,"排除词生成中","assistant","streaming");message(c,"排除词失败","assistant","failed");
    expect(await knowledge.searchInSession(c.conv.id,"排除词")).toEqual([]);
  });
  it("does not rewrite unchanged rows or re-embed existing content",async()=>{
    const c=setup();message(c,"光合作用的原文。");await knowledge.indexEmbeddings(c.conv.id);const first=rows(c.conv.id);
    await knowledge.indexEmbeddings(c.conv.id);expect(rows(c.conv.id)).toEqual(first);expect(mocks.embeds).toHaveBeenCalledTimes(1);
  });
  it("invalidates search cache and vectors when message text changes",async()=>{
    const c=setup();const m=message(c,"光合作用旧内容");await knowledge.indexEmbeddings(c.conv.id);
    const a=await knowledge.retrievePassages(c.conv.id,"光合作用");const b=await knowledge.retrievePassages(c.conv.id,"光合作用");expect(a.cacheHit).toBe(false);expect(b.cacheHit).toBe(true);
    repo.messages.setContent(m.id,"天气新内容");await knowledge.indexEmbeddings(c.conv.id);
    expect(mocks.embeds).toHaveBeenCalledTimes(2);const result=await knowledge.retrievePassages(c.conv.id,"光合作用");expect(result.cacheHit).toBe(false);expect(result.candidates).toEqual([]);
  });
  it("coalesces embedding jobs and discards an embedding computed for superseded content",async()=>{
    const c=setup();const m=message(c,"光合作用旧内容");let release!:(v:Float32Array[])=>void;
    mocks.embeds.mockImplementationOnce(()=>new Promise< Float32Array[]>(resolve=>{release=resolve;}));
    const first=knowledge.indexEmbeddings(c.conv.id);const second=knowledge.indexEmbeddings(c.conv.id);expect(first).toBe(second);
    repo.messages.setContent(m.id,"天气新内容");release([vector("光合作用")]);await first;
    expect(rows(c.conv.id).map(r=>r.text)).toEqual(["天气新内容"]);
    const vectors=db.prepare("SELECT v.* FROM knowledge_passage_vector v JOIN knowledge_passage p ON p.id=v.passage_id WHERE p.conversation_id=?").all(c.conv.id);
    expect(vectors).toHaveLength(1);expect(mocks.embeds).toHaveBeenCalledTimes(2);
  });
  it("does not return a stale passage if text changes during query embedding",async()=>{
    const c=setup();const m=message(c,"光合作用旧内容");await knowledge.indexEmbeddings(c.conv.id);
    mocks.query.mockImplementationOnce(async()=>{repo.messages.setContent(m.id,"天气新内容");return vector("光合作用");});
    expect((await knowledge.retrievePassages(c.conv.id,"光合作用")).candidates).toEqual([]);
  });
  it("renaming a card invalidates cached source metadata without editing its messages",async()=>{
    mocks.available=false;const c=setup();message(c,"改名检查内容");await knowledge.retrievePassages(c.conv.id,"改名检查");
    db.prepare("UPDATE card SET title=? WHERE id=?").run("新标题",c.card.id);
    const result=await knowledge.retrievePassages(c.conv.id,"改名检查");expect(result.cacheHit).toBe(false);expect(result.candidates[0]!.cardTitle).toBe("新标题");
  });
  it("does not return deleted messages from a cached result",async()=>{
    mocks.available=false;const c=setup();const m=message(c,"删除测试词");await knowledge.retrievePassages(c.conv.id,"删除测试词");
    db.prepare("DELETE FROM message WHERE id=?").run(m.id);expect((await knowledge.retrievePassages(c.conv.id,"删除测试词")).candidates).toEqual([]);
  });
  it("isolates conversations including a malformed topic card reference",async()=>{
    mocks.available=false;const a=setup(),b=setup();message(b,"其他会话私有事实");knowledge.indexConversation(b.conv.id);
    knowledge.upsertTopic(a.conv.id,"私有事实",b.card.id);expect(await knowledge.searchInSession(a.conv.id,"私有事实")).toEqual([]);
  });
  it("overview covers sibling branches without requiring literal keyword matches",async()=>{
    mocks.available=false;const c=setup();message(c,"主线主题");const a=branch(c,"艺术"),b=branch(c,"科技");message(a,"光影构图");message(b,"芯片设计");
    const result=await knowledge.searchInSession(c.conv.id,"总结所有分支");expect(new Set(result.map(r=>r.cardId)).size).toBe(3);
  });
});

const historyMessage=(id:string,role:"user"|"assistant",content:string,thread_id="t"):KnowledgeAssistantMessage=>({id,role,content,thread_id,conversation_id:"c",evidence:[],run_id:null,created_at:id,status:"complete"});
const cnd=(id:number,text:string,cardId="card"):Candidate=>({passageId:id,messageId:`m${id}`,cardId,role:"assistant",text,question:"",cardTitle:cardId,path:cardId,createdAt:"2026-09-07",startOffset:0,endOffset:text.length,score:1});
describe("RAG follow-ups and token budgets",()=>{
  it("carries only complete turns from the same assistant thread before this question",()=>{
    const history=[historyMessage("1","user","星桥是什么"),historyMessage("2","assistant","是一种协议"),historyMessage("3","user","秘密","other"),historyMessage("4","assistant","别的答案","other"),historyMessage("5","user","它的限制呢")];
    const kept=rag.assistantHistory(history,"t","5");expect(kept.map(m=>m.id)).toEqual(["1","2"]);expect(rag.retrievalQuestion("它的限制呢",kept)).toContain("星桥是什么");expect(rag.retrievalQuestion("新主题",kept)).toBe("新主题");
  });
  it("retains the subject of a follow-up even after a very long previous answer",()=>{
    const items=[historyMessage("1","user","星桥协议是什么"),historyMessage("2","assistant","很长的解释".repeat(1000)),historyMessage("3","user","它有什么限制")];
    const history=rag.assistantHistory(items,"t","3");expect(history).toHaveLength(2);expect(rag.retrievalQuestion("它有什么限制",history)).toContain("星桥协议");
    expect(history.reduce((sum,m)=>sum+rag.ragTokens(m.content),0)).toBeLessThanOrEqual(1200);
  });
  it("does not include stopped or failed assistant output as follow-up history",()=>{
    const items=[historyMessage("1","user","旧问题"),{...historyMessage("2","assistant","半句"),status:"stopped" as const},historyMessage("3","user","新问题")];
    expect(rag.assistantHistory(items,"t","3")).toEqual([]);
  });
  it("removes identical passages but retains conflicting claims",()=>{
    const result=rag.buildRagRequest("星桥限制",[],[cnd(1,"允许联网"),cnd(2,"允许联网","other"),cnd(3,"不允许联网")],32000);
    expect(result.evidence.flatMap(e=>e.excerpts)).toHaveLength(2);expect(result.messages.at(-1)!.content).toContain("不允许联网");
  });
  it("keeps request within the budget including history, evidence metadata and output reserve",()=>{
    const input=Array.from({length:60},(_,i)=>cnd(i,`事实${i}。`+"长文本".repeat(100),`card${i%3}`));
    const result=rag.buildRagRequest("比较各个分支",[],input,4096);
    expect(result.inputTokens+result.outputReserve).toBeLessThanOrEqual(Math.floor(4096*.85));expect(result.evidence.length).toBeGreaterThan(0);
  });
  it("rejects an oversized question instead of silently truncating it",()=>{
    expect(()=>rag.buildRagRequest("问题".repeat(10000),[],[],4096)).toThrow("问题过长");
  });
  it("keeps absence of evidence explicit",()=>{
    expect(rag.buildRagRequest("不存在的知识",[],[],32000).messages.at(-1)!.content).toContain("未检索到相关证据");
  });
  it("injects a quoted assistant excerpt into the final user message",()=>{
    const result=rag.buildRagRequest("展开讲讲",[],[cnd(1,"星桥协议支持离线运行。")],32000,"星桥协议支持离线运行。");
    const last=result.messages.at(-1)!.content;
    expect(last).toContain("引用助手回答：\n星桥协议支持离线运行。");
    expect(last).toContain("本轮问题：展开讲讲");
  });
  it("omits the quote block when no quote is passed",()=>{
    const result=rag.buildRagRequest("展开讲讲",[],[],32000,null);
    expect(result.messages.at(-1)!.content).not.toContain("引用助手回答");
  });
});
