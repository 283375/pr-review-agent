import { run } from './index'

// Actions entrypoint. The catch swallows everything: run() has already
// reported the failure via core.setFailed, and rethrowing would only
// duplicate the error in the runner log.
run().catch(() => {})
