/**
 * @fileoverview Single Firebase instance for the extension, owned by the
 * service worker.
 *
 * Uses the `firebase/auth/web-extension` entry point (purpose-built for MV3:
 * IndexedDB persistence that survives service-worker restarts, no DOM needed
 * for email/password / credential sign-in). Firestore is initialized with
 * long-polling because the WebChannel streaming transport is unreliable inside
 * an MV3 service worker.
 *
 * Bundled into the service worker by esbuild (tools/build.mjs); never loaded as
 * a plain <script>. The popup talks to the worker via chrome.runtime messages
 * rather than holding its own Firebase instance.
 *
 * @module FirebaseInit
 */

import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth/web-extension';
import { initializeFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { FIREBASE_CONFIG, USE_EMULATOR, EMULATOR } from './firebase-config.js';

export const app = initializeApp(FIREBASE_CONFIG);
export const auth = getAuth(app);
export const db = initializeFirestore(app, { experimentalForceLongPolling: true });

if (USE_EMULATOR) {
  connectAuthEmulator(auth, `http://${EMULATOR.host}:${EMULATOR.authPort}`, {
    disableWarnings: true,
  });
  connectFirestoreEmulator(db, EMULATOR.host, EMULATOR.firestorePort);
  console.log('[ProScan] Firebase pointed at local emulator suite');
}
