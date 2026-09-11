// Reproducible local lexical/retrieval baseline, not an LLM answer-quality benchmark.
// Always uses a disposable DB and disables model downloads/inference.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dataDir=mkdtempSync(join(tmpdir(),"kk-rag-eval-"));
process.env.KNOW_KNOW_DATA_DIR=dataDir;
process.env.KNOW_KNOW_EMBEDDINGS="off";
const {runMigrations}=await import("../src/server/migrate.js");runMigrations();
const repo=await import("../src/server/repo.js");
const {getDb,closeDb}=await import("../src/server/db.js");
const {indexConversation,retrievePassages}=await import("../src/server/knowledge.js");
const {buildRagRequest}=await import("../src/server/rag.js");
try {
  const p=repo.providers.create({type:"custom",name:"evaluation",api_base:"http://127.0.0.1:1",default_model:"offline",is_default:false,capabilities:{web_search:false,thinking:false,tool_calls:false,force_search:false,models:[],context_window:32000},secret_ref:"",has_secret:false});
  const conv=repo.conversations.create(p,"offline","off","default");const root=repo.cards.createMain(conv.id);
  const labels=["星桥","蓝鲸","赤羽","银杉","碧海","紫藤","苍鹭","白榆"];
  const expected=new Map<string,string>();let messages=0;
  const sourceStarted=performance.now();
  getDb().transaction(()=>{
    for (const label of labels) {
      const card=repo.cards.createBranch({conversation_id:conv.id,parent_card_id:root.id,title:label,source_anchor_id:null as any,initial_snapshot_id:"pending"});
      for(let i=0;i<100;i++) {
        const term=`${label}协议${i}`;
        const text=`${term}的背景说明。`+"这里介绍系统的普通背景与使用过程。".repeat(55)+`\n\n${term}限制：仅允许离线运行，不支持在线同步。`;
        const m=repo.messages.create({conversation_id:conv.id,card_id:card.id,role:"assistant",content:text,plaintext:text,status:"complete"});messages++;
        if(i===73)expected.set(term,m.id);
      }
    }
  })();
  const indexStart=performance.now();indexConversation(conv.id);const indexMs=performance.now()-indexStart;
  const trials=[];
  for(const [term,id] of expected) {
    const question=`${term}有什么限制？`;
    const begin=performance.now();const found=await retrievePassages(conv.id,question);const retrievalMs=performance.now()-begin;
    const request=buildRagRequest(question,[],found.candidates,32000);
    const cacheStart=performance.now();const cached=await retrievePassages(conv.id,question);const cacheMs=performance.now()-cacheStart;
    trials.push({question,foundExpected:request.evidence.some(e=>e.excerpts?.some(x=>x.message_id===id&&x.text.includes("仅允许离线运行"))),retrievalMs:+retrievalMs.toFixed(2),cacheMs:+cacheMs.toFixed(2),cacheHit:cached.cacheHit,inputTokensEstimate:request.inputTokens,evidenceTokensEstimate:request.evidenceTokens});
  }
  const report={description:"Synthetic offline lexical retrieval baseline; no real LLM or embedding inference. Latency is machine-specific.",generatedAt:new Date().toISOString(),messages,passages:(getDb().prepare("SELECT count(*) n FROM knowledge_passage").get() as any).n,indexMs:+indexMs.toFixed(2),fixtureAndIndexMs:+(performance.now()-sourceStarted).toFixed(2),passed:trials.filter(t=>t.foundExpected).length,total:trials.length,trials};
  const output=JSON.stringify(report,null,2);console.log(output);
  if(process.argv[2])writeFileSync(process.argv[2],output+"\n");
  if(report.passed!==report.total)process.exitCode=1;
} finally {closeDb();rmSync(dataDir,{recursive:true,force:true});}
