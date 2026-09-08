// sbb doctor: implemented by h3. See docs/spec/cli.md.
export async function run(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: sbb doctor [options]  (see docs/spec/cli.md)');
    return 0;
  }
  console.error('sbb doctor: not implemented yet (task h3)');
  return 1;
}
