// Accounts x CLIs x models available on this machine. No network, no writes.
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverAccounts } from '../lib/paths.js';

/** @typedef {import('../types.js').Account} Account */

// ---------------------------------------------------------------------------
// Static model tables. MAINTAINED BY HAND: none of these CLIs exposes a
// machine-readable model list, so this table has to be edited when a model ships.
// Verified 2026-09-09 against `cursor-agent` modelSelectionHistory in
// ~/.cursor/cli-config.json, ~/.gemini/antigravity-cli/settings.json and the
// Claude 5 family ids reported by the Claude Code banner on this machine.
// ---------------------------------------------------------------------------
export const STATIC_MODELS = Object.freeze({
  claude: [
    { id: 'claude-fable-5-1', label: 'Fable 5.1' },
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ],
  agy: [
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
  ],
  cursor: [
    { id: 'default', label: 'Auto' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'grok-4.6', label: 'Grok 4.6' },
    { id: 'grok-4.5', label: 'Grok 4.5' },
    { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
    { id: 'kimi-k3', label: 'Kimi K3' },
  ],
});

/** CLIs SBB knows how to describe. agy and cursor have one global config, not per account. */
export const CATALOG_CLIS = ['claude', 'codex', 'agy', 'cursor'];

const BINARY_FOR_CLI = { claude: 'claude', codex: 'codex', agy: 'agy', cursor: 'cursor-agent' };

/**
 * `which` without a dependency: first executable of that name on PATH.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|undefined}
 */
export function which(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here, keep looking
    }
  }
  return undefined;
}

/**
 * Minimal TOML reader for top-level scalars only. Stops at the first [section]:
 * SBB needs `model` and `model_catalog_json` from Codex config.toml, nothing else.
 * @param {string} text
 * @returns {Record<string, string|number|boolean>}
 */
export function parseTomlTopLevel(text) {
  /** @type {Record<string, string|number|boolean>} */
  const out = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) break;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const hash = value.search(/\s#/);
    if (hash >= 0) value = value.slice(0, hash).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      out[key] = value.slice(1, -1);
    } else if (value === 'true' || value === 'false') {
      out[key] = value === 'true';
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      out[key] = Number(value);
    }
  }
  return out;
}

/**
 * @param {string|undefined} codexDir
 * @returns {{ model?: string, modelCatalogJson?: string, catalogModels: string[] }}
 */
export function readCodexConfig(codexDir) {
  const result = { catalogModels: /** @type {string[]} */ ([]) };
  if (!codexDir) return result;
  const configPath = join(codexDir, 'config.toml');
  if (!existsSync(configPath)) return result;
  let parsed;
  try {
    parsed = parseTomlTopLevel(readFileSync(configPath, 'utf8'));
  } catch {
    return result;
  }
  if (typeof parsed.model === 'string') result.model = parsed.model;
  if (typeof parsed.model_catalog_json === 'string') {
    result.modelCatalogJson = parsed.model_catalog_json;
    try {
      const catalog = JSON.parse(readFileSync(result.modelCatalogJson, 'utf8'));
      for (const entry of catalog?.models ?? []) {
        if (entry?.slug) result.catalogModels.push(String(entry.slug));
      }
    } catch {
      // an unreadable catalog is reported by the missing models, never faked
    }
  }
  return result;
}

/**
 * @typedef {Object} CatalogRow
 * @property {string} account
 * @property {string} cli
 * @property {{ id: string, label: string|null, source: string }[]} models
 * @property {string} source   how the row was produced
 */

/**
 * @param {{ accounts?: Account[], env?: NodeJS.ProcessEnv, which?: Function, home?: string }} [opts]
 * @returns {CatalogRow[]}
 */
export function catalog(opts = {}) {
  const accounts = opts.accounts ?? discoverAccounts();
  const env = opts.env ?? process.env;
  const whichCmd = opts.which ?? which;
  const home = opts.home ?? homedir();
  /** @type {Record<string, string|undefined>} */
  const binaries = {};
  for (const cli of CATALOG_CLIS) binaries[cli] = whichCmd(BINARY_FOR_CLI[cli], env);

  /** @type {CatalogRow[]} */
  const rows = [];
  for (const account of accounts) {
    if (binaries.claude && account.claudeDir) {
      rows.push({
        account: account.name,
        cli: 'claude',
        models: STATIC_MODELS.claude.map((m) => ({ ...m, source: 'static' })),
        source: 'static table (hand-maintained)',
      });
    }
    if (binaries.codex && account.codexDir) {
      const config = readCodexConfig(account.codexDir);
      /** @type {{ id: string, label: string|null, source: string }[]} */
      const models = [];
      if (config.model) models.push({ id: config.model, label: null, source: 'config.toml:model' });
      for (const slug of config.catalogModels) {
        if (!models.some((m) => m.id === slug)) {
          models.push({ id: slug, label: null, source: 'config.toml:model_catalog_json' });
        }
      }
      rows.push({
        account: account.name,
        cli: 'codex',
        models,
        source: config.modelCatalogJson ? 'config.toml + model_catalog_json' : 'config.toml',
      });
    }
  }

  // agy and cursor keep one global config on this machine; they are not account-scoped.
  for (const cli of ['agy', 'cursor']) {
    if (!binaries[cli]) continue;
    rows.push({
      account: 'default',
      cli,
      models: STATIC_MODELS[cli].map((m) => ({ ...m, source: 'static' })),
      source: `static table (hand-maintained; global config under ${join(home, cli === 'agy' ? '.gemini' : '.cursor')})`,
    });
  }
  return rows;
}
