#!/usr/bin/env node
// Preserve the standalone provider's original entry point; implementation is shared.
import { installNativeHost } from '../install/install-host.mjs'

process.stdout.write(`${await installNativeHost()}\n`)
