import * as core from '@actions/core'
import { run } from './main'

// Actions entrypoint (bundled to dist/review.js). Failures are reported via
// core.setFailed; rethrowing would only duplicate the error in the runner log.
run().catch((err) => core.setFailed(err instanceof Error ? err.stack ?? err.message : String(err)))
