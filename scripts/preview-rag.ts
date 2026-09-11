// Isolated UI fixture: no real credentials, model calls or user data.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import assert from "node:assert/strict";
export const fixtureDataDir=mkdtempSync(join(tmpdir(),"kk-rag-preview-"));
process.env.KNOW_KNOW_DATA_DIR=fixtureDataDir;
process.env.KNOW_KNOW_EMBEDDINGS="off";
// Validate the resolved path before importing the app (which runs migrations).
const {getDbPath}=await import("../src/server/db.js");
assert.equal(getDbPath(),join(fixtureDataDir,"know-know.sqlite"));
const fake=createServer(async(req,res)=>{
  if(req.url?.endsWith("/models")){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({data:[{id:"rag-fixture",supported_parameters:[]}]}));return;}
  let input="";for await (const chunk of req)input+=chunk;
  const body=JSON.parse(input);const question=body.messages?.at(-1)?.content || "";
  const scrollFixture = question.includes("滚动验证");
  const reply=scrollFixture ? Array.from({length:32},(_,i)=>`第 ${i+1} 段：这是隔离环境的流式滚动验证。回答不断增长时，停在底部应自动跟随，向上阅读时应保留当前位置。\n\n`).join("") : question.includes("限制")?"它的主要限制是仅支持离线运行。此前讨论明确指出，星桥协议不支持在线同步。[1]":"根据此前的讨论，星桥协议是一套用于本机知识管理的协议。[1]\n\n它支持离线运行，但不支持在线同步。[1]";
  res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache"});
  for(const text of reply.match(scrollFixture ? /.{1,48}|\n/g : /.{1,6}|\n/g) || []) {
    if(res.destroyed)break;
    res.write(`data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\n`);
    await new Promise(r=>setTimeout(r,scrollFixture ? 100 : 450));
  }
  if(!res.destroyed){res.write(`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:450,completion_tokens:80}})}\n\n`);res.end("data: [DONE]\n\n");}
});
await new Promise<void>(resolve=>fake.listen(8797,"127.0.0.1",resolve));
const {app}=await import("../src/server/index.js");
const repo=await import("../src/server/repo.js");
const p=repo.providers.create({type:"custom",name:"本地测试模型",api_base:"http://127.0.0.1:8797/v1",default_model:"rag-fixture",is_default:true,capabilities:{web_search:false,thinking:false,tool_calls:false,force_search:false,models:["rag-fixture"],context_window:32000},secret_ref:"",has_secret:false});
const conv=repo.conversations.create(p,"rag-fixture","off","default");repo.conversations.rename(conv.id,"RAG 交互验证");
const main=repo.cards.createMain(conv.id);repo.viewState.upsert(conv.id,main.id,0);
for(const [role,text] of [["user","介绍星桥协议"],["assistant","星桥协议是一套本机知识管理协议。\n\n星桥协议支持离线运行。\n\n星桥协议不支持在线同步。"]] as const)repo.messages.create({conversation_id:conv.id,card_id:main.id,role,content:text,plaintext:text,status:"complete"});
serve({fetch:async request=>{
  const response=await app.fetch(request);
  const theme=new URL(request.url).searchParams.get("preview-theme");
  if((theme==="dark" || theme==="light") && response.headers.get("Content-Type")?.includes("text/html")) {
    // Fixture-only theme rendering; never changes an OS/browser preference.
    const headers=new Headers(response.headers);
    headers.delete("Content-Length");
    headers.delete("ETag");
    return new Response((await response.text()).replace("</head>",`<style>:root{color-scheme:${theme}}</style></head>`),{status:response.status,headers});
  }
  return response;
},port:8796,hostname:"127.0.0.1"});
console.log("RAG fixture: http://127.0.0.1:8796/");
const cleanup=()=>{fake.close();process.exit(0);};process.on("SIGTERM",cleanup);process.on("SIGINT",cleanup);
