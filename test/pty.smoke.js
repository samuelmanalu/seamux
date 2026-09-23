const { app } = require('electron');
const { PtyManager } = require('../src/main/pty-manager');

const log = (...a) => console.log('[smoke]', ...a);
let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name);
  if (!cond) failures++;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const m = new PtyManager();
  const transitions = [];
  m.on('status', (s) => { transitions.push(s.state); log('status ->', s.state, '|', s.reason); });

  // 1. spawn a plain shell (not claude, so the test is hermetic)
  const meta = m.create({ cwd: process.env.HOME, title: 'smoke', command: '/bin/bash', args: ['--norc', '-i'] });
  check('create returns an id', !!meta.id);
  check('title is set', meta.title === 'smoke');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1200);

  // 2. output round-trip through the pty
  m.write(meta.id, 'echo SEAMUX_MARKER_OK\n');
  await sleep(1200);
  const replay = m.replay(meta.id);
  check('pty output round-trips', replay.includes('SEAMUX_MARKER_OK'));

  // 3. the headless mirror renders a real screen
  const screen = m.screenText(meta.id);
  check('headless mirror renders screen text', screen.includes('SEAMUX_MARKER_OK'));
  check('screen has the right number of rows', screen.split('\n').length === 34);

  // 4. detector settles to idle once output stops
  await sleep(1800);
  check('settles to idle when quiet', m.describe(m.sessions.get(meta.id)).state === 'idle');

  // 5. detector flags a y/n prompt as needing input
  m.write(meta.id, 'printf "Overwrite file? (y/n) "\n');
  await sleep(1800);
  const st = m.describe(m.sessions.get(meta.id)).state;
  check('detects a y/n prompt as needs_input', st === 'needs_input');

  // 6. resize propagates
  m.resize(meta.id, 100, 20);
  await sleep(400);
  check('resize applies to mirror', m.screenText(meta.id).split('\n').length === 20);

  // 7. exit is observed
  const exited = new Promise((r) => m.on('exit', r));
  m.write(meta.id, 'exit\n');
  await Promise.race([exited, sleep(4000)]);
  await sleep(300);
  check('reports exited', m.describe(m.sessions.get(meta.id)).state === 'exited');

  // A session must not inherit the parent Claude session's identity: doing so
  // silently disables transcript saving, so a killed pane cannot be resumed.
  const { cleanParentEnv, PARENT_SESSION_MARKERS } = require('../src/main/pty-manager');
  const saved = {};
  for (const k of PARENT_SESSION_MARKERS) { saved[k] = process.env[k]; process.env[k] = 'leaked'; }
  const cleaned = cleanParentEnv();
  check('parent session markers are stripped from spawned env',
    PARENT_SESSION_MARKERS.every((k) => !(k in cleaned)),
    PARENT_SESSION_MARKERS.filter((k) => k in cleaned).join(', '));
  check('unrelated variables survive', cleaned.PATH === process.env.PATH);
  for (const k of PARENT_SESSION_MARKERS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }

  m.dispose();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
