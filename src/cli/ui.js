// sbb ui: M3, see docs/spec/ui-server.md. Owner: docs/tasks/m3-h1-ui-server.md.
export async function run(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: sbb ui [--port 4789] [--no-open]  (see docs/spec/ui-server.md)');
    return 0;
  }
  console.error('sbb ui: not implemented yet (M3)');
  return 1;
}
