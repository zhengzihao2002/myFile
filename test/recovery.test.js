"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeJpeg, tmpDir, setMtime, testContext, readTags } = require("./helpers");
const { ctx, et, call, handlers } = testContext();
test.after(() => et.close());
async function photo(root, name, date = "2023:05:01 12:00:00") {
  const file = makeJpeg(path.join(root, name));
  await et.write(file, [["DateTimeOriginal", date], ["OffsetTimeOriginal", "+08:00"]]);
  setMtime(file, Date.parse("2020-01-01T00:00:00Z"));
  return file;
}

test("cancelled multi-file date writes journal recovery before writing and keep folder dates", async () => {
  const root = tmpDir("cancel-date");
  const a = await photo(root, "a.jpg");
  const b = await photo(root, "b.jpg");
  const dirTime = Date.parse("2001-01-01T00:00:00Z");
  setMtime(root, dirTime);
  const scan = await call("exif.batchScan", { paths: [root], options: { reviewAll: true, birthSupported: false } });
  const controller = new AbortController();
  const original = et.write;
  let journalBeforeWrite = false;
  et.write = async function(file, tags, options) {
    if (file === a) {
      journalBeforeWrite = ctx.history.list().some((entry) => ctx.history.getUndo(entry.id)?.exif?.some((item) => item.path === a));
      const result = await original.call(this, file, tags, options);
      controller.abort();
      return result;
    }
    return original.call(this, file, tags, options);
  };
  let result;
  try {
    result = await handlers["exif.batchApply"]({ scanId: scan.scanId, items: [a,b].map((file) => ({path:file,decision:{set:{exif:"modified"}}})) }, {signal:controller.signal,progress(){}});
  } finally { et.write = original; }
  assert.equal(journalBeforeWrite, true);
  assert.equal(result.cancelled, true);
  assert.ok(result.historyId);
  assert.equal(fs.statSync(root).mtimeMs, dirTime);
  assert.equal((await readTags(et,b,["DateTimeOriginal"])).DateTimeOriginal,"2023:05:01 12:00:00");
  const undo = await call("history.revert", {id:result.historyId});
  assert.equal(undo.pending,0);
  assert.equal((await readTags(et,a,["DateTimeOriginal"])).DateTimeOriginal,"2023:05:01 12:00:00");
  assert.equal(fs.statSync(a).mtimeMs,Date.parse("2020-01-01T00:00:00Z"));
  assert.equal(fs.statSync(root).mtimeMs,dirTime);
});

test("failed Undo retains failed EXIF and its file dates, then retries only remaining work", async () => {
  const root = tmpDir("retry-undo");
  const a = await photo(root,"a.jpg");
  const b = await photo(root,"b.jpg");
  const scan = await call("exif.batchScan",{paths:[root],options:{reviewAll:true,birthSupported:false}});
  const saved = await call("exif.batchApply",{scanId:scan.scanId,items:[a,b].map(file=>({path:file,decision:{set:{exif:"modified"}}}))});
  const original = et.write;
  const attempted = [];
  et.write = async function(file,tags,options){attempted.push(file);if(file===b)throw new Error("Drive disconnected");return original.call(this,file,tags,options);};
  let partial;
  try {partial=await call("history.revert",{id:saved.historyId});} finally{et.write=original;}
  assert.ok(partial.pending>0);
  const entry=ctx.history.list().find(entry=>entry.id===saved.historyId);
  assert.equal(entry.reverted,false);
  assert.equal(entry.revertInfo.pending,partial.pending);
  const pending=ctx.history.getUndo(saved.historyId);
  assert.deepEqual(pending.exif.map(item=>item.path),[b]);
  assert.ok(pending.times.some(item=>item.path===b));
  assert.ok(!pending.times.some(item=>item.path===a));
  attempted.length=0;
  et.write=async function(file,tags,options){attempted.push(file);return original.call(this,file,tags,options);};
  let retry;
  try {retry=await call("history.revert",{id:saved.historyId});} finally{et.write=original;}
  assert.equal(retry.pending,0);
  assert.deepEqual(attempted,[b]);
  assert.equal(ctx.history.list().find(entry=>entry.id===saved.historyId).reverted,true);
  assert.equal(ctx.history.getUndo(saved.historyId),null);
  assert.equal((await readTags(et,b,["DateTimeOriginal"])).DateTimeOriginal,"2023:05:01 12:00:00");
});

test("cancelled Copy from reference keeps interrupted metadata writes undoable", async () => {
  const root=tmpDir("cancel-copy");
  const ref=await photo(root,"ref.jpg","2010:02:03 04:05:06");
  const a=await photo(root,"a.jpg");
  const b=await photo(root,"b.jpg");
  const controller=new AbortController();
  const original=et.write;
  et.write=async function(file,tags,options){const result=await original.call(this,file,tags,options);if(file===a)controller.abort();return result;};
  let result;
  try {result=await handlers["exif.copyApply"]({reference:ref,targets:[a,b],options:{date:true,gps:false,fileDates:false}}, {signal:controller.signal,progress(){}});}finally{et.write=original;}
  assert.equal(result.cancelled,true);
  assert.ok(result.historyId);
  assert.ok(ctx.history.getUndo(result.historyId).exif.some(item=>item.path===a));
  const undo=await call("history.revert",{id:result.historyId});
  assert.equal(undo.pending,0);
  assert.equal((await readTags(et,a,["DateTimeOriginal"])).DateTimeOriginal,"2023:05:01 12:00:00");
  assert.equal((await readTags(et,b,["DateTimeOriginal"])).DateTimeOriginal,"2023:05:01 12:00:00");
});

test("cancelling Undo checkpoints successful metadata and retries unfinished dates and files", async () => {
  const root=tmpDir("cancel-undo");
  const a=await photo(root,"a.jpg");
  const b=await photo(root,"b.jpg");
  const scan=await call("exif.batchScan",{paths:[root],options:{reviewAll:true,birthSupported:false}});
  const saved=await call("exif.batchApply",{scanId:scan.scanId,items:[a,b].map(file=>({path:file,decision:{set:{exif:"modified"}}}))});
  const original=et.write;
  const controller=new AbortController();
  et.write=async function(file,tags,options){const out=await original.call(this,file,tags,options);if(file===a)controller.abort();return out;};
  let cancelled;
  try{cancelled=await handlers["history.revert"]({id:saved.historyId},{signal:controller.signal,progress(){}});}finally{et.write=original;}
  assert.equal(cancelled.cancelled,true);
  assert.ok(cancelled.pending>0);
  assert.deepEqual(ctx.history.getUndo(saved.historyId).exif.map(item=>item.path),[b]);
  const attempted=[];
  et.write=async function(file,tags,options){attempted.push(file);return original.call(this,file,tags,options);};
  let retry;
  try{retry=await call("history.revert",{id:saved.historyId});}finally{et.write=original;}
  assert.equal(retry.pending,0);
  assert.deepEqual(attempted,[b]);
  assert.equal(fs.statSync(a).mtimeMs,Date.parse("2020-01-01T00:00:00Z"));
  assert.equal(fs.statSync(b).mtimeMs,Date.parse("2020-01-01T00:00:00Z"));
});
