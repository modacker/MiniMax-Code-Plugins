// Regression nail for the canvas fullscreen button: the Fullscreen API is
// preferred with the opaque overlay as fallback (unavailable API, denied
// request, embedded iframe), Escape exits the overlay but never past an open
// dialog, and the browser-driven api form is tracked through fullscreenchange
// in both directions. DOM-level behaviour (button place, refit after the
// geometry change, poll keeping fullscreen alive) is verified through the
// egolite interaction pass on the real panel.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FULLSCREEN_OFF,FULLSCREEN_API,FULLSCREEN_OVERLAY,requestMode,rejectApi,apiChange,shouldExitOnKey} from '../web/fullscreen-model.mjs';
test('entering prefers the Fullscreen API and falls back to the overlay when the page cannot request it',()=>{
 assert.equal(requestMode(FULLSCREEN_OFF,{apiSupported:true}),FULLSCREEN_API);
 assert.equal(requestMode(FULLSCREEN_OFF,{apiSupported:false}),FULLSCREEN_OVERLAY);
 assert.equal(requestMode(FULLSCREEN_OFF,{}),FULLSCREEN_OVERLAY);
});
test('already-active modes are idempotent so a stray second click never re-enters',()=>{
 assert.equal(requestMode(FULLSCREEN_API,{apiSupported:true}),FULLSCREEN_API);
 assert.equal(requestMode(FULLSCREEN_OVERLAY,{apiSupported:true}),FULLSCREEN_OVERLAY);
});
test('a denied or failed API request drops to the overlay instead of stranding the canvas',()=>{
 assert.equal(rejectApi(FULLSCREEN_API),FULLSCREEN_OVERLAY);
 assert.equal(rejectApi(FULLSCREEN_OFF),FULLSCREEN_OFF);
 assert.equal(rejectApi(FULLSCREEN_OVERLAY),FULLSCREEN_OVERLAY);
});
test('fullscreenchange tracks the panel in both directions without cancelling an unrelated overlay',()=>{
 assert.equal(apiChange(FULLSCREEN_OFF,true),FULLSCREEN_API);
 assert.equal(apiChange(FULLSCREEN_API,true),FULLSCREEN_API);
 assert.equal(apiChange(FULLSCREEN_API,false),FULLSCREEN_OFF);
 assert.equal(apiChange(FULLSCREEN_OVERLAY,false),FULLSCREEN_OVERLAY,'a foreign element leaving fullscreen must not close our overlay');
 assert.equal(apiChange(FULLSCREEN_OVERLAY,true),FULLSCREEN_API);
});
test('Escape exits only the overlay form and never past an open dialog',()=>{
 assert.equal(shouldExitOnKey(FULLSCREEN_OVERLAY,{key:'Escape'}),true);
 assert.equal(shouldExitOnKey(FULLSCREEN_OVERLAY,{key:'Escape',dialogOpen:true}),false,'closing the node/report dialog keeps the canvas fullscreen');
 assert.equal(shouldExitOnKey(FULLSCREEN_API,{key:'Escape'}),false,'the api form exits through the browser itself');
 assert.equal(shouldExitOnKey(FULLSCREEN_OFF,{key:'Escape'}),false);
 assert.equal(shouldExitOnKey(FULLSCREEN_OVERLAY,{key:'Enter'}),false);
});
test('the toolbar carries the fullscreen button ahead of the topology toggle',async()=>{
 const html=await readFile('web/index.html','utf8');
 assert.ok(html.includes('id="graph-fullscreen"'));
 assert.ok(html.indexOf('id="graph-fullscreen"')<html.indexOf('id="graph-mode"'),'the button sits in the canvas toolbar before the structure toggle');
});
