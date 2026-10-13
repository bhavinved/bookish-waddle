// Runs web and server dev processes together; Ctrl+C stops both.
import { spawn } from 'node:child_process';

const procs = ['web', 'server'].map((w) =>
  spawn('npm', ['run', 'dev', '-w', w], { stdio: 'inherit', shell: true }),
);
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
procs.forEach((p) => p.on('exit', stop));
