// Cross-database crash recovery suite (PR #58 re-review point 2). Rotation
// commits the archive side first and the live side second; no transaction can
// span both files, so the crash window between the two commits must leave a
// state that fails verification visibly, loses nothing, and is repaired
// deterministically. Failures are injected for real — an SQLite RAISE(ABORT)
// lands inside the live transaction after the archive commit, and a child
// process is SIGKILLed through the production seam exactly between the two
// commits — never mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
const exec=promisify(execFile),storeModule=fileURLToPath(new URL('../src/store.mjs',import.meta.url)),DAY=86400000;
async function fixture(execute){const dir=await mkdtemp(join(tmpdir(),'wf-recover-'));const store=new Store(dir),engine=new Engine(store,{workspace:dir,execute});return {dir,store,engine,cleanup:async()=>{await engine.close();store.close();await rm(dir,{recursive:true,force:true});}};}
async function finish(engine,id){for(let i=0;i<300;i++){if(!engine.active.has(id))return engine.snapshot(id);await delay(20);}throw Error('timeout');}
async function run(engine,script,requestId){const r=await engine.start({requestId,name:'Recovery suite',executor:'demo',script,input:{}});await engine.approve(r.id,{revision:1});return finish(engine,r.id);}
const twoSteps='const a=await ctx.agent({id:"a",prompt:"a"});const b=await ctx.agent({id:"b",prompt:"b",dependsOn:["a"]});return {a:a.output,b:b.output};';
const chainedCount=store=>Number(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE json_extract(body,'$.type')='archive.rotated'").get().n);

test('a live-transaction abort after the archive commit leaves a reconcilable orphan, not corruption',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const end=await run(f.engine,twoSteps,'recover-1');
 await f.engine.deleteRun(end.id);f.engine.configureTrash({trashRetentionDays:0});
 // REAL failure injection: the archive.rotated insert aborts at the SQLite
 // level while the archive side has already committed — the exact durable
 // state of a crash in the un-transactionable gap between the two commits.
 f.store.db.exec("CREATE TRIGGER inject_rotated_fail BEFORE INSERT ON events WHEN json_extract(new.body,'$.type')='archive.rotated' BEGIN SELECT RAISE(ABORT,'injected live-transaction failure'); END");
 await assert.rejects(async()=>f.store.rotateDue({now:Date.now()}),/injected live-transaction failure/);
 f.store.db.exec('DROP TRIGGER inject_rotated_fail');
 const archive=f.store.archive();
 assert.equal(archive.prepare('SELECT COUNT(*) AS n FROM rotations').get().n,1,'the archive side committed before the abort');
 assert.ok(f.store.get(end.id),'the live rows never left: the live transaction rolled back whole');
 assert.equal(chainedCount(f.store),0,'no archive.rotated event landed');
 assert.equal(f.store.verifyIntegrity().archive.verified,false,'the crash window is visible: an unchained archive copy fails closed');
 assert.equal(f.store.tombstoneCount(),1,'the tombstone is still in the trash');
 // Recovery is part of the next rotation: reconcileOrphans rolls the orphan
 // back (nothing was lost — the live side was never touched), then the
 // rotation simply runs again under a fresh rotationId.
 const redo=f.store.rotateDue({now:Date.now()});
 assert.equal(redo.rotated,true);assert.equal(redo.runCount,1);assert.deepEqual(redo.runs,[end.id]);
 assert.equal(f.store.get(end.id),null,'the redone rotation reclaims the live rows');
 assert.equal(archive.prepare('SELECT COUNT(*) AS n FROM rotations').get().n,1,'the orphan was replaced by the redo, not accumulated');
 const verdict=f.store.verifyIntegrity();
 assert.equal(verdict.archive.verified,true);assert.equal(verdict.events.verified,true);
 assert.equal(f.store.events(redo.rotationId).filter(e=>e.type==='archive.rotated').length,1,'exactly one chained event for the surviving rotation');
 }finally{await f.cleanup();}
});

test('a SIGKILL in the commit gap is repaired by the next startup and the rotation redoes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wf-sigkill-'));let runId;
 try{
  {const store=new Store(dir),engine=new Engine(store,{workspace:dir,execute:async s=>({output:s.id})});
   const end=await run(engine,'return await ctx.agent({id:"a",prompt:"a"});','recover-2');
   runId=end.id;await engine.deleteRun(runId,{by:'cli'});await engine.configureTrash({trashRetentionDays:0});
   await engine.close();store.close();}
  // A child process takes the owner lock, starts the rotation, and is
  // SIGKILLed through the production injection seam (store.afterArchiveCommit)
  // exactly after the archive COMMIT and before the live transaction — a real
  // kill, not a mocked crash. The committed archive copy must survive it.
  const crash=`import {Store} from ${JSON.stringify(storeModule)};
const store=new Store(${JSON.stringify(dir)});
store.afterArchiveCommit=()=>process.kill(process.pid,'SIGKILL');
try{store.rotateDue({now:Date.now()});}finally{store.close();}`;
  await assert.rejects(exec(process.execPath,['--input-type=module','-e',crash]),e=>e.signal==='SIGKILL');
  // Next startup: the Store constructor reconciles the orphan away, the live
  // tombstone is intact, and the rotation redoes cleanly.
  const store=new Store(dir);const engine=new Engine(store,{workspace:dir,execute:async s=>({output:s.id})});
  try{
   const archive=store.archive();
   assert.deepEqual(archive.prepare('SELECT rotationId FROM rotations').all(),[],'startup reconciliation removed the orphaned rotation');
   assert.equal(archive.prepare('SELECT COUNT(*) AS n FROM archive_runs').get().n,0);
   assert.equal(chainedCount(store),0);
   const tombstoned=store.get(runId);
   assert.ok(tombstoned?.deletedAt,'the live tombstone survived the crash untouched');
   assert.equal(store.tombstoneCount(),1);
   const redo=store.rotateDue({now:Date.now()});
   assert.equal(redo.rotated,true);assert.equal(redo.runCount,1);assert.deepEqual(redo.runs,[runId]);
   assert.equal(store.get(runId),null);
   assert.equal(archive.prepare('SELECT COUNT(*) AS n FROM rotations').get().n,1);
   const verdict=store.verifyIntegrity();
   assert.equal(verdict.archive.verified,true);assert.equal(verdict.events.verified,true);
  }finally{await engine.close();store.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('reconcileOrphans is a no-op for healthy rotations and an archive-less store',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 assert.deepEqual(f.store.reconcileOrphans(),{removed:[]},'no archive, nothing to do');
 const end=await run(f.engine,twoSteps,'recover-3');
 await f.engine.deleteRun(end.id);f.engine.configureTrash({trashRetentionDays:0});
 f.store.rotateDue({now:Date.now()});
 assert.deepEqual(f.store.reconcileOrphans(),{removed:[]},'a fully chained rotation is never an orphan');
 assert.equal(f.store.verifyArchive().verified,true);
 }finally{await f.cleanup();}
});
