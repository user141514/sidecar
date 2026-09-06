#!/usr/bin/env node
import { launchRuntime } from './runtime-launcher.mjs'

process.exitCode = await launchRuntime('server')
