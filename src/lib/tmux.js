// Compatibility re-export. The tmux wrapper moved to src/host/tmux.js (docs/spec/ui-server.md
// "Host interface"); every existing import keeps working and no module talks to tmux directly.
export * from '../host/tmux.js';
