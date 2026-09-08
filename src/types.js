// Shared contracts. Pure JSDoc typedefs; nothing is executed from here.
// Every module implements against these names. Change them only through the lead.

/**
 * Account = one isolated config directory set on this macOS user.
 * `default` maps to ~/.claude and ~/.codex; others map to ~/.ai-account-<name>/{claude,codex,...}.
 * @typedef {Object} Account
 * @property {string} name            'default' | 'a' | 'b' | ...
 * @property {string} baseDir         '' for default, else '/Users/x/.ai-account-<name>'
 * @property {string|undefined} claudeDir   CLAUDE_CONFIG_DIR for this account, if the dir exists
 * @property {string|undefined} codexDir    CODEX_HOME for this account, if the dir exists
 */

/**
 * Which CLI a session is running. 'other' covers anything SBB does not have a profile for.
 * @typedef {'claude'|'codex'|'agy'|'cursor'|'other'} CliKind
 */

/**
 * A live tmux pane as reported by `tmux list-panes -a`.
 * @typedef {Object} Pane
 * @property {string} paneId          '%30'
 * @property {string} windowId        '@16'
 * @property {string} session         '24'
 * @property {number} windowIndex     3
 * @property {number} paneIndex       3
 * @property {string} coord           '24:3.3'
 * @property {string} command         pane_current_command, e.g. '2.1.263' (Claude), 'node', 'agy', 'zsh'
 * @property {string} title           pane_title
 * @property {string} path            pane_current_path
 * @property {boolean} inMode         pane_in_mode === 1 (copy-mode etc.)
 * @property {number} pid             pane_pid (the shell)
 * @property {string|undefined} account   value of @ai_account, e.g. 'A' (normalised to lower-case by the roster)
 * @property {string|undefined} codexHome value of @codex_home
 */

/**
 * A live Claude Code session as read from <claudeDir>/sessions/<pid>.json.
 * @typedef {Object} ClaudeSession
 * @property {number} pid
 * @property {string} sessionId
 * @property {string} cwd
 * @property {string|undefined} name        registry name, e.g. 'eagerstudy-b1'
 * @property {'busy'|'idle'|undefined} status
 * @property {string|undefined} tmux        'session:@windowId.%paneId', e.g. '24:@16.%30'
 * @property {string} sock                  messagingSocketPath
 * @property {string} keyFile               path of the <pid>.<sha256>.key file
 * @property {number|undefined} peerProtocol
 * @property {string[]} peerFeatures
 * @property {string} account               account name this session belongs to
 * @property {string} version
 */

/**
 * A Codex thread known to a CODEX_HOME (state_5.sqlite `threads`).
 * @typedef {Object} CodexThread
 * @property {string} id            uuid
 * @property {string|undefined} name  auto-generated session name; usable with `codex queue --thread`
 * @property {string} cwd
 * @property {string} rolloutPath
 * @property {number} updatedAtMs
 * @property {string} account
 * @property {boolean} hasRollout   false means `codex queue` cannot find it yet
 */

/**
 * A brain record persisted at ~/.sbb/brains/<id>.json (retired ones under _retired/).
 * @typedef {Object} Brain
 * @property {string} id            immutable, unique per machine, never reused: '<TAG>-<seq>' e.g. 'SMS-0012'
 * @property {string} uuid          global identity (UUID v7 or randomUUID), never reused
 * @property {string} name          alias, unique among live brains, [a-z0-9][a-z0-9-]{0,39}
 * @property {'main'|'sub'} role
 * @property {string|null} parent   parent brain id (e.g. 'SMS-0007'); null for main brains (parent is the user)
 * @property {string} account
 * @property {CliKind} cli
 * @property {string|undefined} model
 * @property {string} cwd
 * @property {string} paneId        '%30' (may be stale; always re-resolve before use)
 * @property {string|undefined} coord  'session:window.pane' at registration time
 * @property {number|undefined} pid   CLI process pid when known
 * @property {number} createdAt     epoch ms
 * @property {'spawned'|'adopted'} origin
 * @property {number|undefined} retiredAt  epoch ms once killed/forgotten; record lives in _retired/
 */

/**
 * A resolved delivery target. Produced by registry/resolve.js at send time.
 * @typedef {Object} Target
 * @property {string} address       the input, e.g. 'ios' or 'b/claude:eagerstudy-b1' or 'default/agy:%29'
 * @property {string|undefined} brain  brain name if the address named a brain
 * @property {string|undefined} brainId  brain id if the address named a brain
 * @property {string} account
 * @property {CliKind} cli
 * @property {string} paneId        current pane id
 * @property {string} coord         current 'session:window.pane'
 * @property {ClaudeSession|undefined} claude  present when cli === 'claude' and the session registry was found
 * @property {CodexThread|undefined} codex     present when cli === 'codex' and the thread was found
 */

/**
 * @typedef {'delivered'|'queued'|'unverified'|'blocked'} DeliveryStatus
 */

/**
 * @typedef {'now'|'next'|'later'} Priority
 */

/**
 * What a transport returns. `reason` is required for blocked and unverified.
 * @typedef {Object} Receipt
 * @property {DeliveryStatus} status
 * @property {string} via           'uds' | 'codex-queue' | 'send-keys'
 * @property {string} msgId         32 hex
 * @property {number} elapsedMs
 * @property {string|undefined} reason   machine-readable, e.g. 'pane_in_copy_mode', 'held', 'no_rollout', 'enter_swallowed_twice'
 * @property {string|undefined} detail   human-readable extra
 */

/**
 * The message a transport is asked to deliver. `text` is the fully rendered single-line body,
 * envelope included. Transports never alter the body; the uds transport may wrap it verbatim in
 * a <cross-session-message> envelope when fromName is present (docs/spec/protocols.md section 1).
 * @typedef {Object} OutboundMessage
 * @property {string} msgId
 * @property {string} text
 * @property {Priority} priority
 * @property {string|undefined} replyTo   msgId this replies to
 * @property {string} fromBrain           sender brain name or 'user'
 * @property {string|undefined} fromSock  sender inbox socket (uds:/tmp/cc-socks/<pid>.sock); required for uds delivery, see protocols.md
 * @property {string|undefined} fromName  display name for the recipient ('ios#SMS-0012' or 'Claude'); uds wraps the body with it
 * @property {'bypass'|'prompting'|undefined} fromMode  sender permission mode when known
 */

/**
 * Transport interface. Each of src/transports/{claude-uds,codex-queue,tmux-keys}.js exports an object of this shape.
 * @typedef {Object} Transport
 * @property {string} id                        'uds' | 'codex-queue' | 'send-keys'
 * @property {(target: Target) => boolean} supports
 * @property {(target: Target, message: OutboundMessage, opts?: SendOptions) => Promise<Receipt>} send
 */

/**
 * @typedef {Object} SendOptions
 * @property {number|undefined} verifyTimeoutMs   how long to wait for screen/receipt confirmation (default 4000)
 * @property {boolean|undefined} dryRun           resolve and report what would happen without sending
 */

export {};
