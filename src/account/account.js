// Accounts: one ~/.ai-account-<name>/{claude,codex,gemini,cursor-agent,kimi,grok} set plus a
// ~/bin/ai-<name> wrapper. `add` only creates missing directories and the wrapper; it never
// writes credentials, ~/.zshrc or anything outside HOME. docs/spec/policy.md "sbb account".
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_CLI_DIRS, CLI_DIR_FIELD, discoverAccounts, homeDir } from '../lib/paths.js';
import { listBrains } from '../registry/brains.js';

/** Account names become directory names and wrapper names. */
export const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Directory prefix `~/.ai-account-<name>`. */
export const ACCOUNT_DIR_PREFIX = '.ai-account-';

const TEMPLATE_PATH = fileURLToPath(new URL('./wrapper-template.sh', import.meta.url));

/** Invalid account input. */
export class AccountError extends Error {
  /** @param {string} message @param {string} [reason] */
  constructor(message, reason = 'invalid_account') {
    super(message);
    this.name = 'AccountError';
    this.reason = reason;
  }
}

/**
 * Credential files a CLI writes for a file-based login. macOS keychain logins leave none
 * of these behind, which is why SESSION_MARKERS exists.
 */
const CREDENTIAL_MARKERS = Object.freeze({
  claude: ['.credentials.json'],
  codex: ['auth.json'],
  agy: ['antigravity-cli/antigravity-oauth-token', 'oauth_creds.json'],
  cursor: ['auth.json'],
  kimi: ['credentials/kimi-code.json'],
  grok: ['auth.json'],
});

/**
 * Evidence that a CLI has been used in this dir. A keychain login (no credential file)
 * counts as logged in once a session or config exists; an empty freshly-created dir does
 * not, and a file the generated wrapper writes itself (codex config.toml) is excluded.
 */
const SESSION_MARKERS = Object.freeze({
  claude: ['.claude.json', 'history.jsonl', 'sessions', 'projects'],
  codex: ['sessions', 'archived_sessions', 'state_5.sqlite'],
  agy: ['antigravity-cli/settings.json', 'antigravity-cli/history.jsonl', 'antigravity-cli/conversations', 'settings.json'],
  cursor: ['cli-config.json', 'chats', 'projects'],
  kimi: ['config.toml', 'oauth', 'session_index.jsonl'],
  grok: ['config.toml', 'active_sessions.json', 'sessions'],
});

/** @param {string} dir @param {string} marker */
function markerPresent(dir, marker) {
  const path = join(dir, marker);
  try {
    const stat = statSync(path);
    return stat.isDirectory() ? readdirSync(path).length > 0 : true;
  } catch {
    return false;
  }
}

/**
 * Whether `dir` shows a login for `cli`: a credential file, or a session/config that
 * proves a keychain-backed login. No credential contents are ever read.
 * @param {string} cli @param {string|undefined} dir
 */
export function hasCliLogin(cli, dir) {
  if (!dir) return false;
  const markers = [...(CREDENTIAL_MARKERS[cli] ?? []), ...(SESSION_MARKERS[cli] ?? [])];
  return markers.some((marker) => markerPresent(dir, marker));
}

/** @param {string} name */
export function assertAccountName(name) {
  const value = String(name ?? '').trim();
  if (!ACCOUNT_NAME_RE.test(value)) {
    throw new AccountError(`invalid account name "${name}": expected ${ACCOUNT_NAME_RE}`);
  }
  return value;
}

/** @param {string} name @param {{ home?: string }} [opts] */
export function accountDir(name, opts = {}) {
  return join(opts.home ?? homeDir(), `${ACCOUNT_DIR_PREFIX}${assertAccountName(name)}`);
}

/** @param {string} name @param {{ home?: string }} [opts] */
export function wrapperPath(name, opts = {}) {
  return join(opts.home ?? homeDir(), 'bin', `ai-${assertAccountName(name)}`);
}

/** @returns {string} the wrapper template with placeholders still in place */
export function readTemplate() {
  return readFileSync(TEMPLATE_PATH, 'utf8');
}

/**
 * Substitute the per-account placeholders.
 * @param {string} name @param {string} [template]
 */
export function renderWrapper(name, template = readTemplate()) {
  const account = assertAccountName(name);
  const tag = account.toUpperCase();
  return template
    .replaceAll('__NAME__', account)
    .replaceAll('__TAG__', tag)
    .replaceAll('__ENV__', `AI_${tag}`);
}

/**
 * Accounts on this machine, with per-CLI login state and the brains using each one.
 * @param {{ home?: string, brains?: import('../types.js').Brain[], discover?: typeof discoverAccounts }} [opts]
 */
export function accountList(opts = {}) {
  const home = opts.home ?? homeDir();
  const discover = opts.discover ?? discoverAccounts;
  const brains = opts.brains ?? listBrains();
  return discover().map((account) => {
    /** @type {Record<string, boolean>} */
    const logins = {};
    for (const [cli, field] of Object.entries(CLI_DIR_FIELD)) {
      logins[cli] = hasCliLogin(cli, /** @type {Record<string, string|undefined>} */ (account)[field]);
    }
    return {
      name: account.name,
      baseDir: account.baseDir,
      claudeDir: account.claudeDir,
      codexDir: account.codexDir,
      agyDir: account.agyDir,
      cursorDir: account.cursorDir,
      kimiDir: account.kimiDir,
      grokDir: account.grokDir,
      hasClaudeCreds: logins.claude,
      hasCodexCreds: logins.codex,
      hasAgyCreds: logins.agy,
      hasCursorCreds: logins.cursor,
      hasKimiCreds: logins.kimi,
      hasGrokCreds: logins.grok,
      logins,
      wrapper: account.name === 'default' ? undefined : wrapperPath(account.name, { home }),
      brains: brains.filter((b) => b.account === account.name).map((b) => b.name),
    };
  });
}

/**
 * Create `~/.ai-account-<name>/{claude,codex,gemini,cursor-agent,kimi,grok}` and
 * `~/bin/ai-<name>`. Refuses when the account directory already exists unless `force`.
 * @param {string} name
 * @param {{ home?: string, template?: string, force?: boolean }} [opts]
 * @returns {{ name: string, baseDir: string, claudeDir: string, codexDir: string,
 *             agyDir: string, cursorDir: string, kimiDir: string, grokDir: string,
 *             wrapper: string, created: string[], replaced: boolean }}
 */
export function accountAdd(name, opts = {}) {
  const account = assertAccountName(name);
  const home = opts.home ?? homeDir();
  const base = accountDir(account, { home });
  const wrapper = wrapperPath(account, { home });
  const existed = existsSync(base) || existsSync(wrapper);
  if (existed && !opts.force) {
    throw new AccountError(`account "${account}" already exists at ${base}`, 'account_exists');
  }
  const claudeDir = join(base, ACCOUNT_CLI_DIRS.claude);
  const codexDir = join(base, ACCOUNT_CLI_DIRS.codex);
  const agyDir = join(base, ACCOUNT_CLI_DIRS.agy);
  const cursorDir = join(base, ACCOUNT_CLI_DIRS.cursor);
  const kimiDir = join(base, ACCOUNT_CLI_DIRS.kimi);
  const grokDir = join(base, ACCOUNT_CLI_DIRS.grok);
  const created = [];
  for (const dir of [base, claudeDir, codexDir, agyDir, cursorDir, kimiDir, grokDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      created.push(dir);
    }
  }
  chmodSync(base, 0o700);
  mkdirSync(dirname(wrapper), { recursive: true, mode: 0o755 });
  writeFileSync(wrapper, renderWrapper(account, opts.template), { mode: 0o700 });
  chmodSync(wrapper, 0o700);
  created.push(wrapper);
  return { name: account, baseDir: base, claudeDir, codexDir, agyDir, cursorDir, kimiDir, grokDir, wrapper, created, replaced: existed };
}
