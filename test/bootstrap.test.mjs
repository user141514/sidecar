import test from 'node:test'
import assert from 'node:assert/strict'

import { UNSUPPORTED_DEFAULT_PROFILE_BOOTSTRAP } from '../src/chrome-bootstrap.mjs'

test('default-profile remote-debugging bootstrap is explicitly rejected', () => {
  assert.match(UNSUPPORTED_DEFAULT_PROFILE_BOOTSTRAP, /Chrome 136\+/)
  assert.match(UNSUPPORTED_DEFAULT_PROFILE_BOOTSTRAP, /default Chrome data directory/)
  assert.match(UNSUPPORTED_DEFAULT_PROFILE_BOOTSTRAP, /chrome:\/\/extensions/)
})
