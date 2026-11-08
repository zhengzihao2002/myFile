"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { tmpDir, makeMovie, makeJpeg, testContext } = require("./helpers");
const display = require("../src/main/lib/date-display");
const { ctx, et } = testContext();
test.after(() => et.close());

test("zone labels contain only the UTC offset, without names or parenthetical descriptions", () => {
  const winter = Date.parse("2015-12-29T19:28:42Z");
  const summer = Date.parse("2015-07-01T19:28:42Z");
  assert.equal(display.stamp(winter, { offsetMin: -300 }), "2015-12-29 14:28:42 UTC-05:00");
  assert.equal(display.zoneLabel({ zone: "America/New_York" }, winter), "UTC-05:00");
  assert.equal(display.zoneLabel({ zone: "America/New_York" }, summer), "UTC-04:00");
  assert.equal(display.zoneLabel({ offsetMin: -300 }, winter), "UTC-05:00");
});

test("Show, Modify and metadata dates are independent of the Mac zone and retain genuine stored offsets", async () => {
  const root = tmpDir("show-modify-zones");
  const video = makeMovie(path.join(root, "utc.mov"));
  const keys = makeMovie(path.join(root, "keys.mov"));
  const photo = makeJpeg(path.join(root, "photo.jpg"));
  await et.write(video, [["QuickTime:CreateDate", "2015:12:29 19:28:42Z"]]);
  await et.write(keys, [["Keys:CreationDate", "2015:12:29 14:28:42-05:00"]]);
  await et.write(photo, [["DateTimeOriginal", "2015:12:29 14:28:42"], ["OffsetTimeOriginal", "-05:00"]]);
  const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const before = [video, keys, photo].map(hash);
  const snapshots = [];
  for (const zone of ["America/New_York", "Asia/Shanghai", "UTC"]) {
    const script = `
      const {ctx,et,call}=require('./test/helpers').testContext();
      (async()=>{const result=[];for(const file of process.argv.slice(1)) {
        const show=await call('exif.inspect',{path:file});
        const scan=await call('exif.batchScan',{folder:file,options:{single:true,birthSupported:true}});
        const modify=await call('exif.batchOutcome',{scanId:scan.scanId,path:file,decision:{set:{exif:'created',modified:'created'}}});
        result.push({show,modify});
      }console.log(JSON.stringify(result));et.close()})().catch(e=>{console.error(e);et.close();process.exitCode=1});`;
    const result = JSON.parse(execFileSync(process.execPath, ["-e", script, video, keys, photo], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, TZ: zone }, encoding: "utf8" }));
    for (const { show, modify } of result) {
      for (const key of ["created", "modified"]) assert.equal(show.dateDisplay.fields[key].text, modify.fields[key].beforeText);
      assert.equal(show.taken.displayText, modify.fields.exif.beforeText);
      assert.equal(modify.fields.exif.afterText, modify.fields.created.afterText);
      assert.equal(modify.fields.modified.afterText, modify.fields.created.afterText);
    }
    const show = result[0].show;
    assert.equal(show.taken.displayText, "2015-12-29 19:28:42 UTC+00:00");
    assert.equal(show.taken.offset, null, "a converted offset isn't stored metadata");
    const tag = show.groups.find(g=>g.group==='QuickTime').tags.find(t=>t.tag==='CreateDate');
    assert.match(tag.note, /Original local offset is not stored/);
    assert.equal(tag.value, "2015-12-29 19:28:42 UTC+00:00", "no ExifTool host-zone conversion leaks into All metadata");
    assert.equal(show.dateDisplay.fields.created.systemText, undefined, "no secondary Mac-zone display");
    assert.equal(result[1].show.taken.displayText, "2015-12-29 14:28:42 UTC-05:00", "Keys offset really is stored");
    assert.equal(result[2].show.taken.displayText, "2015-12-29 14:28:42 UTC-05:00", "photo offset really is stored");
    snapshots.push(result.map(({show})=>({taken:show.taken.displayText,fields:Object.values(show.dateDisplay.fields).map(f=>f.text), metadataDates:show.groups.flatMap(g=>g.tags.filter(t=>/Date|Time/.test(t.tag)).map(t=>({group:g.group,tag:t.tag,value:t.value})))})));
  }
  assert.deepEqual(snapshots[1], snapshots[0]);
  assert.deepEqual(snapshots[2], snapshots[0]);
  assert.deepEqual([video,keys,photo].map(hash), before, "inspecting doesn't rewrite file bytes");
});
