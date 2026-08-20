/**
 * Run something with the console captured, so a test can assert on what the
 * user will actually read in the logs of the integration.
 *
 * @param {() => Promise<any>} run
 * @param {string} [level] the LOG_LEVEL to run it under
 * @returns {{ result: Promise<any>, of: (kind: string) => Array<string> }}
 */
export function captureLogs(run, level = 'info') {
  const written = [];
  const original = { log: console.log, error: console.error, level: process.env.LOG_LEVEL };
  console.log = (...args) => written.push(args.join(' '));
  console.error = (...args) => written.push(args.join(' '));
  process.env.LOG_LEVEL = level;
  const restore = () => {
    console.log = original.log;
    console.error = original.error;
    if (original.level === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = original.level;
    }
  };
  const result = run().finally(restore);
  return {
    result,
    of: (kind) => written.filter((line) => line.includes(`[${kind}]`)),
  };
}
