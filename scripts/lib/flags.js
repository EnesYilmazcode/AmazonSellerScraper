/**
 * @fileoverview Build flags.
 *
 * CLOUD_SYNC is off in 2.1 and 2.2. Nothing goes into the sync outbox, the
 * service worker refuses PROSCAN_EXPORT, and the popup hides the ProScan
 * sign-in and the Export to ProScan button. Sync comes back with the
 * per-run outbox (audit report, phase 4).
 *
 * Loaded as a plain global (`Flags`) in the popup, and as a CommonJS
 * module in Jest and the bundled service worker.
 */

const Flags = {
    CLOUD_SYNC: false
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Flags;
}
