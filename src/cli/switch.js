// sbb switch: M2, see docs/spec/. Owner per docs/tasks/m2-*.md.
export async function run(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: sbb switch [options]  (see docs/spec/)');
    return 0;
  }
  console.error('sbb switch: not implemented yet (M2)');
  return 1;
}
