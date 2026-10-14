// JavaScript for Automation, run by myFile as:
//   osascript -l JavaScript jxa-set-creation.js <jobs.json>
//
// Sets file and folder creation dates through NSFileManager, which every Mac
// has; no developer tools needed. jobs.json is [{"p": path, "s": seconds}].
// Prints a JSON array holding "" for each success or an error message.

ObjC.import("Foundation");

function run(argv) {
  var data = $.NSData.dataWithContentsOfFile(argv[0]);
  var text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  var jobs = JSON.parse(text);
  var fm = $.NSFileManager.defaultManager;
  var results = [];
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    try {
      var when = $.NSDate.dateWithTimeIntervalSince1970(job.s);
      var attrs = $.NSDictionary.dictionaryWithObjectForKey(when, "NSFileCreationDate");
      var ok = fm.setAttributesOfItemAtPathError(attrs, job.p, null);
      results.push(ok ? "" : "macOS did not accept the new creation date");
    } catch (e) {
      results.push(String(e));
    }
  }
  return JSON.stringify(results);
}
