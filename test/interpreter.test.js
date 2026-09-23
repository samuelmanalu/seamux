'use strict';
/**
 * The safety property matters more than the classification: a real secret must
 * never appear in what gets sent to the model.
 */
const { interpret, redact, restore, extractJson } = require('../src/main/interpreter');

let fails = 0;
const ok = (n, c, d) => { console.log((c?'PASS  ':'FAIL  ')+n+(c||!d?'':`  (${d})`)); if(!c) fails++; };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

const SECRET = 'p@ssw0rd-SUPER-SECRET-123';

/* ---- redaction ---- */
let r = redact(`DB_PASSWORD=${SECRET}\nHOST=db.internal`);
ok('secret is removed from the redacted text', !r.redacted.includes(SECRET), r.redacted);
ok('placeholder takes its place', /«V1»/.test(r.redacted));
ok('the real value is held locally', [...r.map.values()].includes(SECRET));
ok('key names survive (needed for classification)', r.redacted.includes('DB_PASSWORD'));

r = redact('export TOKEN="abc123"');
ok('export form is redacted', !r.redacted.includes('abc123'), r.redacted);
ok('quotes are preserved around the placeholder', /"«V1»"/.test(r.redacted), r.redacted);

r = redact('password: hunter2');
ok('colon form is redacted', !r.redacted.includes('hunter2'), r.redacted);

r = redact('Always use the stage database, never production.');
eq('prose is left untouched', r.redacted, 'Always use the stage database, never production.');
eq('prose creates no placeholders', r.map.size, 0);

r = redact('Note: this service is tricky and needs the stage config every time');
ok('a sentence with a colon is treated as prose', r.map.size === 0, r.redacted);

// regression: a multi-word label nearly leaked a username to the model
r = redact('oracle user: svc_recon');
ok('multi-word label is redacted', !r.redacted.includes('svc_recon'), r.redacted);
r = redact('api key: sk-abc123xyz');
ok('"api key:" is redacted', !r.redacted.includes('sk-abc123xyz'), r.redacted);
r = redact('the reason we do this: because the stage box is shared');
ok('a long label with a sentence stays prose', r.map.size === 0, r.redacted);
r = redact('Deploy notes: run liquibase first');
ok('a short label with a sentence value stays prose', r.map.size === 0, r.redacted);

/* ---- restore ---- */
const map = new Map([['«V1»', SECRET]]);
let res = restore({ DB_PASSWORD: '«V1»' }, map);
eq('placeholder maps back to the real value', res.vars.DB_PASSWORD, SECRET);
res = restore({ FAKE: '«V99»' }, map);
eq('an invented placeholder is dropped, not guessed', res.vars, {});
eq('and is reported', res.unknown, ['FAKE']);
res = restore({ LITERAL: 'plain-text' }, map);
eq('a literal value passes through', res.vars.LITERAL, 'plain-text');

/* ---- json extraction ---- */
eq('plain json', extractJson('{"a":1}').a, 1);
eq('fenced json', extractJson('```json\n{"a":2}\n```').a, 2);
eq('json with chatter around it', extractJson('Sure!\n{"a":3}\nHope that helps').a, 3);
ok('non-json throws', (() => { try { extractJson('no json here'); return false; } catch { return true; } })());

/* ---- end to end with a stubbed model ---- */
(async () => {
  const paste = [
    '# stage creds',
    `DB_PASSWORD=${SECRET}`,
    'DB_HOST=stage-db.internal',
    'Always use the stage database, never production.',
    'Start by summarising the open merge requests.',
  ].join('\n');

  let sentToModel = null;
  const out = await interpret(paste, {
    run: async (redactedText) => {
      sentToModel = redactedText;
      return JSON.stringify({
        name: 'Stage DB',
        variables: { DB_PASSWORD: '«V1»', DB_HOST: '«V2»' },
        instructions: 'Always use the stage database, never production.',
        preprompt: 'Start by summarising the open merge requests.',
        notes: '',
      });
    },
  });

  ok('THE SECRET IS NEVER SENT TO THE MODEL', !sentToModel.includes(SECRET), sentToModel);
  eq('secret is restored locally', out.variables.DB_PASSWORD, SECRET);
  eq('second value restored', out.variables.DB_HOST, 'stage-db.internal');
  eq('instructions classified', out.instructions, 'Always use the stage database, never production.');
  eq('opening prompt classified', out.preprompt, 'Start by summarising the open merge requests.');
  eq('a name is suggested', out.name, 'Stage DB');
  eq('placeholder count reported', out.placeholders, 2);

  // a model that hallucinates a value must not be able to inject one
  const evil = await interpret(`API_KEY=${SECRET}`, {
    run: async () => JSON.stringify({
      name: 'x', variables: { API_KEY: '«V1»', INJECTED: 'attacker-value' },
      instructions: '', preprompt: '', notes: '',
    }),
  });
  eq('real value still restored', evil.variables.API_KEY, SECRET);
  eq('a literal the model added is kept as a literal (visible for review)', evil.variables.INJECTED, 'attacker-value');

  console.log(fails === 0 ? '\nINTERPRETER: ALL PASSED' : `\nINTERPRETER: ${fails} FAILED`);
  process.exit(fails ? 1 : 0);
})();
