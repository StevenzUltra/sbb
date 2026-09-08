// sbb policy: inspect and edit ~/.sbb/config.json. docs/spec/policy.md "sbb policy".
import { BRAIN_CLIS, getBrain } from '../registry/brains.js';
import { PEER_MODES, readConfig, updateConfig } from '../policy/config.js';
import { EXIT, UsageError, main, parse, renderTable, writeJson } from './util.js';
import { heldStatus } from '../policy/held.js';

const USAGE = `usage: sbb policy show [--json]
       sbb policy peers on|off|moderated
       sbb policy set <id|name> [--peers on|off] [--autonomous on|off]
       sbb policy allow <a> <b>
       sbb policy deny <a> <b>
       sbb policy quota [--floor-weekly <n>] [--main-reserve <n>]
       sbb policy spawn-args <cli> "<args>"`;

const OPTIONS = {
  json: { type: 'boolean' },
  peers: { type: 'string' },
  autonomous: { type: 'string' },
  'floor-weekly': { type: 'string' },
  'main-reserve': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

/** @param {unknown} value @param {string} flag */
function onOff(value, flag) {
  if (value !== 'on' && value !== 'off') throw new UsageError(`${flag} must be on|off`);
  return value === 'on';
}

/** @param {unknown} value @param {string} flag */
function percentArg(value, flag) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new UsageError(`${flag} must be a percent between 0 and 100`);
  return n;
}

/** @param {string} ref */
function brainIdFor(ref) {
  const brain = getBrain(ref);
  if (!brain) throw new UsageError(`unknown brain "${ref}"`);
  return brain.id;
}

export async function run(argv, deps = {}) {
  return main(async () => {
    // `<args>` may start with `-`, which strict parseArgs reads as another option
    // (`--permission-mode bypassPermissions`). This subcommand takes its tail verbatim.
    if (argv[0] === 'spawn-args') return spawnArgsCommand(argv.slice(1), deps);
    const { values, positionals } = parse(argv, OPTIONS);
    if (values.help) {
      console.log(USAGE);
      return EXIT.OK;
    }
    const sub = positionals[0];
    const readCfg = deps.readConfig ?? readConfig;
    const writeCfg = deps.updateConfig ?? updateConfig;
    const opts = { sbbDir: deps.sbbDir, hostname: deps.hostname };

    if (!sub || sub === 'show') {
      const config = readCfg(opts);
      if (values.json) {
        writeJson(config);
        return EXIT.OK;
      }
      console.log(`machineTag  ${config.machineTag}`);
      console.log(`peers       ${config.peers}`);
      console.log(`quota       floorWeekly=${config.quota.floorWeekly} mainReserve=${config.quota.mainReserve}`);
      const spawnEntries = Object.entries(config.spawn.cliArgs);
      console.log(`spawn       ${spawnEntries.length ? spawnEntries.map(([cli, text]) => `${cli}=${text}`).join(', ') : '-'}`);
      console.log(`allow       ${config.allow.length ? config.allow.map(([a, b]) => `${a} <-> ${b}`).join(', ') : '-'}`);
      const brains = Object.entries(config.brains);
      console.log(`brains      ${brains.length ? brains.map(([id, e]) => `${id}${e.peers ? ` peers=${e.peers}` : ''}${e.autonomous ? ' autonomous' : ''}`).join(', ') : '-'}`);
      return EXIT.OK;
    }

    if (sub === 'peers') {
      const mode = positionals[1];
      if (!PEER_MODES.includes(mode)) throw new UsageError(`policy peers needs one of ${PEER_MODES.join('|')}`);
      writeCfg((config) => ({ ...config, peers: mode }), opts);
      console.log(`peers ${mode}`);
      return EXIT.OK;
    }

    if (sub === 'set') {
      const ref = positionals[1];
      if (!ref) throw new UsageError('policy set needs <id|name>');
      if (values.peers === undefined && values.autonomous === undefined) {
        throw new UsageError('policy set needs --peers on|off or --autonomous on|off');
      }
      const id = brainIdFor(ref);
      writeCfg((config) => {
        const entry = { ...(config.brains[id] ?? {}) };
        if (values.peers !== undefined) {
          if (onOff(values.peers, '--peers')) delete entry.peers;
          else entry.peers = 'off';
        }
        if (values.autonomous !== undefined) {
          if (onOff(values.autonomous, '--autonomous')) entry.autonomous = true;
          else delete entry.autonomous;
        }
        const brains = { ...config.brains };
        if (Object.keys(entry).length) brains[id] = entry;
        else delete brains[id];
        return { ...config, brains };
      }, opts);
      console.log(`brains.${id} updated`);
      return EXIT.OK;
    }

    if (sub === 'allow' || sub === 'deny') {
      const [a, b] = positionals.slice(1);
      if (!a || !b) throw new UsageError(`policy ${sub} needs <a> <b>`);
      const config = writeCfg((current) => {
        const key = (ref) => getBrain(ref)?.id ?? ref;
        const pair = [key(a), key(b)];
        const rest = current.allow.filter(([x, y]) => !(x === pair[0] && y === pair[1]) && !(x === pair[1] && y === pair[0]));
        return { ...current, allow: sub === 'allow' ? [...rest, pair] : rest };
      }, opts);
      console.log(`allow ${config.allow.map(([x, y]) => `${x} <-> ${y}`).join(', ') || '-'}`);
      return EXIT.OK;
    }

    if (sub === 'quota') {
      if (values['floor-weekly'] === undefined && values['main-reserve'] === undefined) {
        const config = readCfg(opts);
        console.log(`floorWeekly=${config.quota.floorWeekly} mainReserve=${config.quota.mainReserve}`);
        return EXIT.OK;
      }
      const config = writeCfg((current) => ({
        ...current,
        quota: {
          floorWeekly: values['floor-weekly'] === undefined
            ? current.quota.floorWeekly
            : percentArg(values['floor-weekly'], '--floor-weekly'),
          mainReserve: values['main-reserve'] === undefined
            ? current.quota.mainReserve
            : percentArg(values['main-reserve'], '--main-reserve'),
        },
      }), opts);
      console.log(`floorWeekly=${config.quota.floorWeekly} mainReserve=${config.quota.mainReserve}`);
      return EXIT.OK;
    }

    throw new UsageError(`unknown policy subcommand "${sub}"`);
  });
}

/**
 * `sbb policy spawn-args <cli> "<args>"` writes `spawn.cliArgs[<cli>]`; an empty string
 * removes the entry. The tail is taken verbatim so values starting with `-` survive.
 * @param {string[]} tail @param {{ updateConfig?: Function, sbbDir?: string, hostname?: string }} deps
 */
function spawnArgsCommand(tail, deps) {
  if (tail.includes('-h') || tail.includes('--help')) {
    console.log('usage: sbb policy spawn-args <cli> "<args>"   (an empty string removes the entry)');
    return EXIT.OK;
  }
  const cli = tail[0];
  if (!cli) throw new UsageError('policy spawn-args needs <cli> "<args>"');
  if (!BRAIN_CLIS.includes(cli)) throw new UsageError(`policy spawn-args: unknown cli "${cli}" (${BRAIN_CLIS.join('|')})`);
  const rest = tail.slice(1);
  const text = (rest[0] === '--' ? rest.slice(1) : rest).join(' ').trim();
  const writeCfg = deps.updateConfig ?? updateConfig;
  const config = writeCfg((current) => {
    const cliArgs = { ...current.spawn.cliArgs };
    if (text === '') delete cliArgs[cli];
    else cliArgs[cli] = text;
    return { ...current, spawn: { ...current.spawn, cliArgs } };
  }, { sbbDir: deps.sbbDir, hostname: deps.hostname });
  const value = config.spawn.cliArgs[cli];
  console.log(value === undefined ? `spawn.cliArgs.${cli} removed` : `spawn.cliArgs.${cli}=${value}`);
  return EXIT.OK;
}

/** @param {Record<string, any>[]} holds */
export function heldTable(holds) {
  return renderTable(
    ['MSGID', 'STATUS', 'HELD', 'FROM', 'TO', 'REASON'],
    holds.map((h) => [
      String(h.msgId).slice(0, 8),
      heldStatus(h),
      new Date(h.heldAt ?? 0).toISOString().replace('T', ' ').slice(0, 19),
      h.sender?.name ?? h.sender?.brain ?? 'user',
      h.target?.brain ?? h.target?.address ?? '-',
      h.expiredReason ? `${h.reason ?? 'peers_moderated'}; ${h.expiredReason}` : (h.reason ?? 'peers_moderated'),
    ]),
  );
}
