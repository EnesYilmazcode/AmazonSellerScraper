/**
 * @fileoverview Downloads asked for from the page (DOWNLOAD {format}).
 *
 * The file is made by the same Exporter.build the popup uses. A content
 * script has no chrome.downloads and a service worker has no
 * URL.createObjectURL, so the worker hands the file to chrome.downloads as
 * a data: URL, which keeps the save-as prompt. Chrome drops a URL over 2 MB
 * on its way between processes, so a larger file goes back to the page as
 * base64 and the dock saves it there with a download link.
 *
 * @module Download
 */

const FORMATS = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    json: 'application/json'
};

/** Largest base64 body sent to chrome.downloads as a data: URL. */
const DATA_URL_MAX = 1.5 * 1024 * 1024;

/** Bytes to base64, in chunks so a large file does not overflow the call stack. */
function toBase64(bytes) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

/**
 * Makes the file for `format` from the latest run and delivers it.
 *
 * @param {Object} deps
 * @param {Object} deps.Exporter - scripts/modules/exporter.js
 * @param {function(): Promise<{results: Object[], spread: Object}>} deps.getState
 * @param {function(Object): Promise<number>} deps.download - chrome.downloads.download as a promise
 * @param {string} format - xlsx, csv or json
 * @returns {Promise<Object>} {ok, via: 'downloads', filename} or
 *   {ok, via: 'page', filename, mime, base64}, or {error, message}
 */
async function deliver({ Exporter, getState, download, max = DATA_URL_MAX }, format) {
    const mime = FORMATS[format];
    if (!mime) return { error: 'format', message: 'ProScan can save Excel, CSV or JSON.' };
    const { results, spread } = await getState();
    if (!results || results.length === 0) return { error: 'empty', message: 'There is nothing to download yet.' };
    const { blob, filename } = Exporter.build(format, results, spread);
    const base64 = toBase64(new Uint8Array(await blob.arrayBuffer()));
    if (base64.length > max) return { ok: true, via: 'page', filename, mime, base64 };
    await download({ url: `data:${mime};base64,${base64}`, filename, saveAs: true });
    return { ok: true, via: 'downloads', filename };
}

module.exports = { deliver, toBase64, FORMATS, DATA_URL_MAX };
