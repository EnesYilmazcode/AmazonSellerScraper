/**
 * @fileoverview Build flags.
 *
 * CLOUD_SYNC turns on the ProScan account and sync: signed-in scans go
 * into the outbox and flush to the dashboard, and the popup shows sign-in
 * and Export to ProScan. It was off in 2.1 and 2.2 and is on from 2.3.
 *
 * Loaded as a plain global (`Flags`) in the popup, and as a CommonJS
 * module in Jest and the bundled service worker.
 */

const Flags = {
    CLOUD_SYNC: true
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Flags;
}
