'use strict';

// The `seamux` command: puts tasks on the Seamux board from a terminal.
// Seamux sets SEAMUX_SOCKET and SEAMUX_PROJECT in every terminal it starts,
// and puts this command on PATH.

const path = require('path');
const { request } = require(path.join(__dirname, '..', 'main', 'control.js'));

const HELP = `seamux — put tasks on the Seamux board

  seamux task add "<title>" [--brief "<text>"] [--after <task id>]... [--agent <id>]
      Add a task to this project's Backlog. --after: it waits for that task
      to be done (repeat for several). Prints the new task's id.
  seamux task list
      This project's tasks: id, column, title, what each waits for.

  --project <folder>   another project than this terminal's
`;

function parse(argv) {
  const out = { _: [], after: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--brief' || a === '--agent' || a === '--project') out[a.slice(2)] = argv[++i];
    else if (a === '--after') out.after.push(argv[++i]);
    else if (a === '-h' || a === '--help') out.help = true;
    else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parse(process.argv.slice(2));
  const [group, verb, ...rest] = args._;
  if (args.help || !group || group === 'help') { process.stdout.write(HELP); return 0; }
  const socket = process.env.SEAMUX_SOCKET;
  if (!socket) throw new Error('run this inside a Seamux terminal (SEAMUX_SOCKET is not set)');
  const project = args.project ? path.resolve(args.project) : process.env.SEAMUX_PROJECT;
  if (!project) throw new Error('no project: use --project <folder>');

  if (group === 'task' && verb === 'add') {
    const title = rest.join(' ').trim();
    if (!title) throw new Error('give the task a title: seamux task add "<title>"');
    const r = await request(socket, { cmd: 'task.add', project, title, brief: args.brief || '', after: args.after.filter(Boolean), agent: args.agent || null });
    if (!r.ok) throw new Error(r.error);
    process.stdout.write(`${r.task.id}  added to Backlog: ${r.task.title}\n`);
    return 0;
  }
  if (group === 'task' && verb === 'list') {
    const r = await request(socket, { cmd: 'task.list', project });
    if (!r.ok) throw new Error(r.error);
    if (!r.tasks.length) { process.stdout.write('No tasks yet.\n'); return 0; }
    for (const t of r.tasks) {
      const waits = t.blockedBy.length ? `  (waits for ${t.blockedBy.join(', ')})` : '';
      process.stdout.write(`${t.id}  [${t.column}]  ${t.title}${waits}\n`);
    }
    return 0;
  }
  throw new Error(`unknown command: ${args._.join(' ')}\n\n${HELP}`);
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`seamux: ${err.message}\n`);
  process.exit(1);
});
