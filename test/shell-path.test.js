'use strict';
const { loginShellPath, parsePath, mergePath } = require('../src/main/shell-path');

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`));
  if (!ok) fails++;
};

eq('parse plain', parsePath('__SEAMUX_PATH__/a:/b__SEAMUX_PATH__'), '/a:/b');
eq('parse among rc noise', parsePath('Welcome!\nlast login\n__SEAMUX_PATH__/a:/b__SEAMUX_PATH__\n'), '/a:/b');
eq('parse no marker', parsePath('nothing here'), null);
eq('parse empty value', parsePath('__SEAMUX_PATH____SEAMUX_PATH__'), null);

eq('merge keeps priority order', mergePath('/login/bin:/usr/bin', '/usr/bin:/bin'), '/login/bin:/usr/bin:/bin');
eq('merge drops empties', mergePath('/a::/b', '', null, '/c'), '/a:/b:/c');
eq('merge dedupes within one', mergePath('/a:/a:/b'), '/a:/b');

// The real case: a Dock launch's PATH gains the shell's directories, in front.
const dock = '/usr/bin:/bin:/usr/sbin:/sbin';
eq('dock PATH gains shell dirs first',
  mergePath('/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin:/bin', dock),
  '/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');

eq('shell that exits non-zero -> null', loginShellPath('/usr/bin/false'), null);
eq('missing shell -> null', loginShellPath('/no/such/shell'), null);
const real = loginShellPath('/bin/sh');
console.log((real && real.includes('/usr/bin') ? 'PASS  ' : 'FAIL  ') + 'reads a real shell PATH');
if (!(real && real.includes('/usr/bin'))) fails++;

console.log(fails === 0 ? '\nSHELL PATH: ALL PASSED' : `\nSHELL PATH: ${fails} FAILED`);
process.exit(fails ? 1 : 0);
