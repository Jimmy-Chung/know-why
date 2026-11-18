import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SSEEvent } from "../src/shared/types.js";
import type { AdapterRequest } from "../src/server/adapters/types.js";
const state=vi.hoisted(()=>({mode:"normal",requests:[] as AdapterRequest[],release:undefined as undefined|(()=>void)}));
vi.mock("../src/server/adapters/index.js",async original=>({...await original<any>(),createAdapter:async()=>({
  async *stream(req:AdapterRequest){
    state.requests.push(req);
    yield {type:"delta",text:"根据此前讨论，"};
    if(state.mode==="stop") await new Promise<void>((resolve,reject)=>{
      if(req.signal?.aborted)return reject(req.signal.reason);
      req.signal?.addEventListener("abort",()=>reject(req.signal!.reason),{once:true});
    });
    if(state.mode==="gated")await new Promise<void>(resolve=>{state.release=resolve;});
    if(state.mode==="error")throw new Error("fixture upstream failure");
    yield {type:"delta",text:"星桥协议适合离线使用。[1]"};
    yield {type:"done",usage:{prompt_tokens:123,completion_tokens:20}};
  }
})}));
let app:typeof import("../src/server/index.js")["app"];
let repo:typeof import("../src/server/repo.js");
let orchestrator:typeof import("../src/server/orchestrator.js");
let dbModule:typeof import("../src/server/db.js");
const dir=mkdtempSync(join(tmpdir(),"kk-rag-stream-"));
beforeAll(async()=>{
  process.env.KNOW_KNOW_DATA_DIR=dir;
  ({app}=await import("../src/server/index.js"));repo=await import("../src/server/repo.js");orchestrator=await import("../src/server/orchestrator.js");dbModule=await import("../src/server/db.js");
});
beforeEach(()=>{state.mode="normal";state.requests=[];state.release=undefined;});
afterAll(()=>{dbModule.closeDb();rmSync(dir,{recursive:true,force:true});});
function setup(){
  const p=repo.providers.create({type:"custom",name:"test",api_base:"http://127.0.0.1:1",default_model:"test",is_default:false,capabilities:{web_search:false,thinking:false,tool_calls:false,force_search:false,models:[],context_window:32000},secret_ref:"",has_secret:false});
  const conv=repo.conversations.create(p,"test","off","default");const card=repo.cards.createMain(conv.id);
  repo.messages.create({conversation_id:conv.id,card_id:card.id,role:"assistant",content:"星桥协议适合离线使用。",plaintext:"星桥协议适合离线使用。",status:"complete"});return conv;
}
async function post(convId:string,question:string,threadId="t",key=crypto.randomUUID()){
  const res=await app.request(`/api/conversations/${convId}/assistant`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({question,thread_id:threadId,idempotency_key:key})});
  expect(res.status).toBe(200);return await res.json() as {userMsgId:string;runId:string};
}
function events(runId:string,onEvent?:(e:SSEEvent)=>void){
  const seen:SSEEvent[]=[];let unsub=()=>{};
  const done=new Promise<SSEEvent[]>(resolve=>{unsub=orchestrator.subscribe(runId,event=>{
    seen.push(event);onEvent?.(event);
    if(event.type==="done"||event.type==="error"){unsub();resolve(seen);}
  });});return {seen,done};
}
describe("assistant RAG streaming lifecycle",()=>{
  it("emits text before completion, persists sources, usage and timing metrics",async()=>{
    state.mode="gated";const conv=setup();const run=await post(conv.id,"星桥协议是什么");
    const e=events(run.runId);expect(orchestrator.startAssistantRunIfPending(run.runId)).toBe(true);
    await vi.waitFor(()=>expect(e.seen.some(e=>e.type==="assistant_delta")).toBe(true));
    expect(repo.runs.get(run.runId)!.status).toBe("running");expect(e.seen.some(e=>e.type==="done")).toBe(false);
    state.release!();await e.done;
    const answer=repo.assistant.list(conv.id).find(m=>m.role==="assistant")!;
    expect(answer.status).toBe("complete");expect(answer.evidence[0]!.excerpts?.[0]!.text).toContain("离线");
    expect(repo.runs.get(run.runId)!.usage).toMatchObject({prompt_tokens:123});
    const metric=dbModule.getDb().prepare("SELECT * FROM knowledge_rag_metrics WHERE run_id=?").get(run.runId) as any;
    expect(metric.first_token_ms).toBeLessThan(metric.total_ms);expect(metric.estimated_input_tokens).toBeGreaterThan(0);
    expect(state.requests[0]!.webMode).toBe("off");
  });
  it("continues only the current thread and allows deliberate repeated questions",async()=>{
    const conv=setup();const first=await post(conv.id,"星桥协议是什么");let e=events(first.runId);orchestrator.startAssistantRunIfPending(first.runId);await e.done;
    const second=await post(conv.id,"它的限制呢");e=events(second.runId);orchestrator.startAssistantRunIfPending(second.runId);await e.done;
    expect(state.requests[1]!.messages.some(m=>m.role==="assistant"&&m.content.includes("离线"))).toBe(true);
    const other=await post(conv.id,"它的限制呢","other");e=events(other.runId);orchestrator.startAssistantRunIfPending(other.runId);await e.done;
    expect(state.requests).toHaveLength(2); // The new thread has no subject to resolve: no evidence, no LLM call.
    const direct=await post(conv.id,"星桥协议限制","fresh");e=events(direct.runId);orchestrator.startAssistantRunIfPending(direct.runId);await e.done;
    expect(state.requests[2]!.messages.filter(m=>m.role==="assistant")).toHaveLength(0);
    const repeat=await post(conv.id,"星桥协议是什么");expect(repeat.runId).not.toBe(first.runId);
  });
  it("stopping preserves partial text and does not mark it complete",async()=>{
    state.mode="stop";const conv=setup();const r=await post(conv.id,"星桥协议");const e=events(r.runId,event=>{if(event.type==="assistant_delta")orchestrator.stopRun(r.runId);});
    orchestrator.startAssistantRunIfPending(r.runId);await e.done;
    const answer=repo.assistant.list(conv.id).find(m=>m.role==="assistant")!;
    expect(answer.status).toBe("stopped");expect(answer.content).toBe("根据此前讨论，");expect(repo.runs.get(r.runId)!.status).toBe("stopped");
  });
  it("upstream failure persists incomplete status and emits an error",async()=>{
    state.mode="error";const conv=setup();const r=await post(conv.id,"星桥协议");const e=events(r.runId);orchestrator.startAssistantRunIfPending(r.runId);await e.done;
    expect(e.seen.at(-1)!.type).toBe("error");expect(repo.assistant.list(conv.id).find(m=>m.role==="assistant")!.status).toBe("failed");
  });
  it("returns an explicit no-evidence response without spending a model call",async()=>{
    const conv=setup();const r=await post(conv.id,"完全陌生的火星矿物");const e=events(r.runId);orchestrator.startAssistantRunIfPending(r.runId);await e.done;
    expect(state.requests).toHaveLength(0);expect(repo.assistant.list(conv.id).find(m=>m.role==="assistant")!.content).toContain("未检索到");
    expect(repo.runs.get(r.runId)!.usage).toMatchObject({prompt_tokens:0,completion_tokens:0});
  });
  it("reconnects to the exact in-memory partial answer before the next DB flush",async()=>{
    state.mode="gated";const conv=setup();const r=await post(conv.id,"星桥协议");const e=events(r.runId);
    orchestrator.startAssistantRunIfPending(r.runId);
    await vi.waitFor(()=>expect(state.release).toBeTypeOf("function"));
    expect(orchestrator.assistantRunSnapshot(r.runId)?.content).toBe("根据此前讨论，");
    const response=await app.request(`/api/runs/${r.runId}/stream`);const reader=response.body!.getReader();
    let received="";const decoder=new TextDecoder();
    while(!received.includes("event: assistant_message")){const chunk=await reader.read();received+=decoder.decode(chunk.value);}
    expect(received).toContain("根据此前讨论，");expect(received).not.toContain("event: assistant_delta");
    state.release!();await e.done;
    while(true){const chunk=await reader.read();if(chunk.done)break;received+=decoder.decode(chunk.value);}
    expect(received).toContain("event: done");expect(state.requests).toHaveLength(1);
  });
  it("can stop an assistant run before generation starts",async()=>{
    const conv=setup();const r=await post(conv.id,"星桥协议");expect(orchestrator.stopRun(r.runId)).toBe(true);
    expect(orchestrator.startAssistantRunIfPending(r.runId)).toBe(false);expect(repo.runs.get(r.runId)!.status).toBe("stopped");expect(state.requests).toHaveLength(0);
  });
  it("stops a chat run mid-stream: run and message both land stopped",async()=>{
    state.mode="stop";const conv=setup();const card=repo.cards.listForConversation(conv.id)[0]!;
    const res=await app.request(`/api/cards/${card.id}/messages`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:"离线协议怎么用"})});
    expect(res.status).toBe(200);const {run}=await res.json() as {run:{id:string}};
    const e=events(run.id,ev=>{if(ev.type==="delta")orchestrator.stopRun(run.id);});
    expect(orchestrator.startRunIfPending(run.id)).toBe(true);
    await e.done;
    expect(repo.runs.get(run.id)!.status).toBe("stopped");
    const last=repo.messages.listForCard(card.id).find(m=>m.run_id===run.id&&m.role==="assistant")!;
    expect(last.role).toBe("assistant");expect(last.status).toBe("stopped");
  });
  it("marks interrupted runs stopped on restart (including orphaned queued runs)",async()=>{
    const conv=setup();const r=await post(conv.id,"助手提问");repo.runs.update(r.runId,{status:"running"});
    const answer=repo.assistant.add({conversation_id:conv.id,role:"assistant",content:"部分答案",evidence:[],run_id:r.runId,thread_id:"t",status:"streaming"});
    const queued=await post(conv.id,"稍后提问");orchestrator.recoverStalledRuns();
    expect(repo.runs.get(r.runId)!.status).toBe("stopped");expect(repo.runs.get(queued.runId)!.status).toBe("stopped");
    expect(repo.assistant.list(conv.id).find(m=>m.id===answer.id)).toMatchObject({content:"部分答案",status:"stopped",run_status:"stopped"});
  });
  it("HTTP SSE delivers a completed snapshot on reconnect instead of hanging or generating again",async()=>{
    const conv=setup();const r=await post(conv.id,"星桥协议");
    const first=await app.request(`/api/runs/${r.runId}/stream`);const body=await first.text();
    expect(body).toContain("event: assistant_delta");expect(body).toContain("event: done");
    const reconnect=await app.request(`/api/runs/${r.runId}/stream`);const text=await reconnect.text();
    expect(text).toContain("event: assistant_message");expect(text).toContain("event: done");expect(text).not.toContain("event: assistant_delta");expect(state.requests).toHaveLength(1);
  });
});
