'use strict';
const { parseEnv, stringifyEnv, maskValue } = require('../src/main/dotenv');

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`));
  if (!ok) fails++;
};

eq('plain pair', parseEnv('A=1'), { A: '1' });
eq('export prefix', parseEnv('export TOKEN=abc'), { TOKEN: 'abc' });
eq('spaces around =', parseEnv('A = 1'), { A: '1' });
eq('comments and blanks', parseEnv('# note\n\nA=1\n  # another\nB=2'), { A: '1', B: '2' });
eq('double quoted with spaces', parseEnv('A="hello world"'), { A: 'hello world' });
eq('single quoted keeps backslash', parseEnv("A='raw\\n'"), { A: 'raw\\n' });
eq('double quoted expands \\n', parseEnv('A="line1\\nline2"'), { A: 'line1\nline2' });
eq('inline comment stripped', parseEnv('A=1 # trailing'), { A: '1' });
eq('hash inside quotes kept', parseEnv('A="a#b"'), { A: 'a#b' });
eq('empty value', parseEnv('A='), { A: '' });
eq('value with = inside', parseEnv('DSN=key=val;x=y'), { DSN: 'key=val;x=y' });
eq('url with slashes', parseEnv('U=https://h:5432/db?a=b'), { U: 'https://h:5432/db?a=b' });
eq('multi-line quoted (PEM style)',
  parseEnv('KEY="-----BEGIN-----\nline2\n-----END-----"\nNEXT=1'),
  { KEY: '-----BEGIN-----\nline2\n-----END-----', NEXT: '1' });
eq('malformed line skipped, rest survives', parseEnv('this is not a pair\nA=1'), { A: '1' });
eq('later wins on duplicate key', parseEnv('A=1\nA=2'), { A: '2' });
eq('CRLF handled', parseEnv('A=1\r\nB=2'), { A: '1', B: '2' });
eq('BOM stripped', parseEnv('﻿A=1'), { A: '1' });
eq('quoted empty', parseEnv('A=""'), { A: '' });
eq('dotted key', parseEnv('spring.datasource.url=jdbc:x'), { 'spring.datasource.url': 'jdbc:x' });
eq('no input', parseEnv(''), {});
eq('null input', parseEnv(null), {});

// round trip
const tricky = { A: 'hello world', B: 'a#b', C: 'plain', D: 'line1\nline2' };
eq('round trip', parseEnv(stringifyEnv(tricky)), tricky);

// masking must never reveal the middle
eq('mask short', maskValue('abc'), '•••');
eq('mask long', maskValue('supersecretvalue123'), 'su••••••••••••23');
eq('mask empty', maskValue(''), '');
const m = maskValue('AKIAIOSFODNN7EXAMPLE');
console.log((!m.includes('OSFODNN') ? 'PASS  ' : 'FAIL  ') + 'mask hides the middle');
if (m.includes('OSFODNN')) fails++;

console.log(fails === 0 ? '\nDOTENV: ALL PASSED' : `\nDOTENV: ${fails} FAILED`);
process.exit(fails ? 1 : 0);
