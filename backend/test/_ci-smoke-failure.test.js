// TEMPORARY — intentional failure to exercise the CI failure-notification
// path end-to-end. Remove this file once the Tracker notify step has been
// confirmed to fire on a real failed run.
const test = require('node:test');
const assert = require('node:assert');

test('intentional failure: verifies Tracker notify on CI failure', () => {
  assert.strictEqual('expected', 'actual',
    'forced failure to test the .gitea workflow failure → Tracker pipeline');
});
