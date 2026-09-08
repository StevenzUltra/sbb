// Accounts: one ~/.ai-account-<name>/{claude,codex} pair plus a ~/bin/ai-<name> wrapper.
// `add` only creates missing directories and the wrapper; it never writes credentials,
// ~/.zshrc or anything outside HOME. docs/spec/policy.md "Accounts".
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAccounts, homeDir } from '../lib/paths.js';
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
 * Accounts on this machine, with credential presence and the brains using each one.
 * @param {{ home?: string, brains?: import('../types.js').Brain[], discover?: typeof discoverAccounts }} [opts]
 */
export function accountList(opts = {}) {
  const home = opts.home ?? homeDir();
  const discover = opts.discover ?? discoverAccounts;
  const brains = opts.brains ?? listBrains();
  return discover().map((account) => {
    const claudeCreds = account.claudeDir ? join(account.claudeDir, '.credentials.json') : undefined;
    const codexCreds = account.codexDir ? join(account.codexDir, 'auth.json') : undefined;
    return {
      name: account.name,
      baseDir: account.baseDir,
      claudeDir: account.claudeDir,
      codexDir: account.codexDir,
      hasClaudeCreds: claudeCreds ? existsSync(claudeCreds) : false,
      hasCodexCreds: codexCreds ? existsSync(codexCreds) : false,
      wrapper: account.name === 'default' ? undefined : wrapperPath(account.name, { home }),
      brains: brains.filter((b) => b.account === account.name).map((b) => b.name),
    };
  });
}

/**
 * Create `~/.ai-account-<name>/{claude,codex}` and `~/bin/ai-<name>`.
 * Refuses when the account directory already exists unless `force`.
 * @param {string} name
 * @param {{ home?: string, template?: string, force?: boolean }} [opts]
 * @returns {{ name: string, baseDir: string, claudeDir: string, codexDir: string,
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
  const claudeDir = join(base, 'claude');
  const codexDir = join(base, 'codex');
  const created = [];
  for (const dir of [base, claudeDir, codexDir]) {
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
  return { name: account, baseDir: base, claudeDir, codexDir, wrapper, created, replaced: existed };
}
