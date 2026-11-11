/**
 * @fileoverview Firebase config for the ProScan extension.
 *
 * Prod talks to the proscanbot project. The dev build
 * (`PROSCAN_ENV=dev npm run build`) sets the literal __PROSCAN_EMULATOR__
 * through esbuild `define` and points at the local emulator suite under the
 * demo-proscan project, the same id the dashboard dev build uses. Web API
 * keys are public identifiers, not secrets; access is governed by the
 * Firestore security rules.
 *
 * @module FirebaseConfig
 */

/* global __PROSCAN_EMULATOR__ */
export const USE_EMULATOR =
  typeof __PROSCAN_EMULATOR__ !== 'undefined' && __PROSCAN_EMULATOR__ === true;

const PROD_CONFIG = {
  apiKey: 'AIzaSyAp0HrcvFwpMxrlqbxa9xjUvwGoTa7QpUU',
  authDomain: 'proscanbot.firebaseapp.com',
  projectId: 'proscanbot',
  appId: '1:886322190589:web:496bad0e5793cf90eec694',
  storageBucket: 'proscanbot.firebasestorage.app',
  messagingSenderId: '886322190589',
};

// demo-* projects only ever talk to the emulators. Written inline so the
// prod build folds them away.
export const FIREBASE_CONFIG = USE_EMULATOR
  ? {
      ...PROD_CONFIG,
      authDomain: 'demo-proscan.firebaseapp.com',
      projectId: 'demo-proscan',
      storageBucket: 'demo-proscan.appspot.com',
    }
  : PROD_CONFIG;

export const EMULATOR = USE_EMULATOR
  ? { host: '127.0.0.1', authPort: 9099, firestorePort: 8080 }
  : null;
