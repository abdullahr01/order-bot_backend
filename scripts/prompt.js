// Terminal questions for the account scripts. Hidden answers (passwords) are never echoed.
// Lines are queued, so answers typed ahead or piped in are not lost.
import { createInterface } from 'node:readline';

export function openPrompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const lines = [];
  const waiting = [];
  let closed = false;
  rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
  rl.on('close', () => {
    closed = true;
    while (waiting.length) waiting.shift()(null);
  });
  const next = () => (lines.length ? Promise.resolve(lines.shift()) : closed ? Promise.resolve(null) : new Promise((resolve) => waiting.push(resolve)));
  const echo = rl._writeToOutput;

  return {
    async ask(question, { hidden = false } = {}) {
      // The question is readline's prompt, so redrawing the typed line keeps it on screen.
      rl.setPrompt(question);
      rl.prompt();
      if (hidden) rl._writeToOutput = () => {};
      try {
        const line = await next();
        if (line === null) throw new Error('No answer was given.');
        return hidden ? line : line.trim();
      } finally {
        if (hidden) {
          rl._writeToOutput = echo;
          process.stdout.write('\n');
        }
      }
    },
    close: () => rl.close(),
  };
}
