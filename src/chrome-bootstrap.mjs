#!/usr/bin/env node

export const UNSUPPORTED_DEFAULT_PROFILE_BOOTSTRAP =
  'Chrome 136+ disables --remote-debugging-port and --remote-debugging-pipe for the default Chrome data directory. Install the Conversation Sidecar extension once through chrome://extensions instead.'

if (import.meta.url === `file://${process.argv[1]}`) {
  console.error(UNSUPPORTED_DEFAULT_PROFILE_BOOTSTRAP)
  process.exitCode = 2
}
