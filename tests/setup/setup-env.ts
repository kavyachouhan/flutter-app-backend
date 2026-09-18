// Runs before any module under test is imported, because src/config/env.ts
// validates and freezes process.env at import time. The fixture replaces the
// environment outright so a developer's shell variables cannot leak in.
import { testEnv } from '../fixtures/env.js';

Object.assign(process.env, testEnv);
