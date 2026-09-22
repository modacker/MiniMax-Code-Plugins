import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
import {PROMPT_LIMIT,PROMPT_DATA_EMBEDDING,promptLengthFailure,detectDataEmbedding} from '../src/prompt-budget.mjs';
import {previewTopology} from '../src/topology.mjs';
import {Store} from '../src/store.mjs';import {Engine} from '../src/engine.mjs';
async function fixture(execute){const dir=await mkdtemp(join(tmpdir(),'workflow-test-'));const store=new Store(dir);const engine=new Engine(store,{workspace:dir,execute,runTimeoutMs:10000});return {engine,store,start:async r=>{const draft=await engine.start(r);return draft.status==='pending_review'?engine.approve(draft.id,{revision:draft.revision}):draft;},cleanup:async()=>{await engine.close();store.close();await rm(dir,{recursive:true,force:true});}};}
async function done(e,id){for(let i=0;i<300;i++){const s=e.snapshot(id);if(!e.active.has(id))return s;await delay(20);}throw Error('test timeout');}
const request=(script,extra={})=>({requestId:'r1',name:'测试',executor:'demo',script,input:{},...extra});
test('over-limit prompt fails the run with structured, actionable details',async()=>{
 const f=await fixture(async()=>({output:null}));
 try{
  const r=await f.start(request(`return await ctx.agent({id:'big',prompt:'x'.repeat(${PROMPT_LIMIT+1})});`,{requestId:'over'}));
  const out=await done(f.engine,r.id);
  assert.equal(out.status,'failed');
  assert.equal(out.errorDetails.code,'PROMPT_LENGTH');
  assert.equal(out.errorDetails.stepId,'big');
  assert.equal(out.errorDetails.length,PROMPT_LIMIT+1);
  assert.equal(out.errorDetails.limit,PROMPT_LIMIT);
  assert.match(out.error,/big/);assert.ok(out.error.includes(String(PROMPT_LIMIT+1)));assert.match(out.error,/input/);
  assert.match(out.errorDetails.suggestion,/input/);
  // The gate fires before the step exists, so the failed dispatch leaves no phantom node.
  assert.equal(out.steps.filter(s=>s.id==='big').length,0);
 }finally{await f.cleanup();}
});
test('prompt boundary semantics are unchanged: exactly at the limit passes, empty is rejected',async()=>{
 const f=await fixture(async s=>({output:s.id}));
 try{
  const ok=await f.start(request(`return await ctx.agent({id:'edge',prompt:'x'.repeat(${PROMPT_LIMIT})});`,{requestId:'edge'}));
  const finished=await done(f.engine,ok.id);
  assert.equal(finished.status,'succeeded');assert.equal(finished.steps[0].status,'succeeded');
  const empty=await f.start(request(`return await ctx.agent({id:'blank',prompt:''});`,{requestId:'blank'}));
  const rejected=await done(f.engine,empty.id);
  assert.equal(rejected.status,'failed');
  assert.equal(rejected.errorDetails.code,'PROMPT_LENGTH');
  assert.equal(rejected.errorDetails.stepId,'blank');
  assert.equal(rejected.errorDetails.length,0);
  assert.equal(rejected.errorDetails.limit,PROMPT_LIMIT);
  assert.match(rejected.errorDetails.message,/blank/);
 }finally{await f.cleanup();}
});
test('detectDataEmbedding flags only prompt-template embeddings of upstream data',()=>{
 for(const script of [
  'const scope=await ctx.agent({id:"a",prompt:"p"});\nawait ctx.agent({id:"b",prompt:`核对以下产物：${JSON.stringify(scope.output)}`,dependsOn:["a"]});',
  'await ctx.agent({id:"b",prompt:`${scope.output}`});',
  'await ctx.agent({id:"b",prompt:`${steps.a.output}`});',
 ])assert.equal(detectDataEmbedding(script),PROMPT_DATA_EMBEDDING,script);
 for(const script of [
  'await ctx.agent({id:"a",prompt:`审查文件 ${file}`});',
  'await ctx.agent({id:"a",prompt:"纯字符串固定指令"});',
  '// 不要写 ${JSON.stringify(x.output)} 这样的内嵌\nawait ctx.agent({id:"a",prompt:"p"});',
  '/* ${scope.output} 仅注释提及 */\nawait ctx.agent({id:"a",prompt:"p"});',
  'await ctx.agent({id:"a",prompt:"请避免 ${JSON.stringify(x.output)} 写法"});',
  'await ctx.agent({id:"a",prompt:"分析材料",input:scope.output});',
  'const data=JSON.stringify(scope.output);await ctx.agent({id:"a",prompt:"p"});',
 ])assert.equal(detectDataEmbedding(script),null,script);
 assert.equal(detectDataEmbedding(null),null);
});
test('previewTopology carries the embedding warning through the static plan',()=>{
 const pathological='const a=await ctx.agent({id:"a",prompt:"p"});\nconst b=await ctx.agent({id:"b",prompt:`汇总：${JSON.stringify(a.output)}`,dependsOn:["a"]});';
 const warned=previewTopology(pathological);
 assert.ok(warned.warnings.includes(PROMPT_DATA_EMBEDDING));
 const clean='const a=await ctx.agent({id:"a",prompt:"p"});\nconst b=await ctx.agent({id:"b",prompt:"汇总",input:a.output,dependsOn:["a"]});';
 assert.ok(!previewTopology(clean).warnings.includes(PROMPT_DATA_EMBEDDING));
});
test('the prompt limit stays single-sourced from the pure module',async()=>{
 assert.equal(PROMPT_LIMIT,30000);
 const failure=promptLengthFailure({stepId:'n',length:40001});
 assert.equal(failure.limit,30000);assert.match(failure.message,/n/);assert.match(failure.message,/40001/);
 const engine=await readFile('src/engine.mjs','utf8');
 assert.ok(!/30_000/.test(engine),'engine must import PROMPT_LIMIT instead of hardcoding the limit');
 const app=await readFile('web/app.source.mjs','utf8');
 assert.ok(app.includes("from '../src/prompt-budget.mjs'"),'web must import the same module rather than duplicate the constant');
 const bundle=await readFile('web/app.js','utf8');
 assert.ok(/3e4|30000/.test(bundle),'the built web bundle must embed the shared limit');
});
