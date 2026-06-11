/** Process entry for the `rpc-shield` bin — all logic lives in buildProgram(). */
import { buildProgram } from './program.js';

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    process.stderr.write(`rpc-shield: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
