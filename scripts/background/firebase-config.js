/**
 * @fileoverview Firebase config for the ProScan extension.
 *
 * Same Firebase project (proscanbot) for dev and prod — only the emulator
 * wiring differs, gated by PROSCAN_ENV which esbuild inlines at build time
 * (see tools/build.mjs `define`). Web API keys are public identifiers, not
 * secrets; access is governed entirely by Firestore security rules.
 *
 * @module FirebaseConfig
 */

export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAp0HrcvFwpMxrlqbxa9xjUvwGoTa7QpUU',
  authDomain: 'proscanbot.firebaseapp.com',
  projectId: 'proscanbot',
  appId: '1:886322190589:web:496bad0e5793cf90eec694',
  storageBucket: 'proscanbot.firebasestorage.app',
  messagingSenderId: '886322190589',
};

// Build dev with `PROSCAN_ENV=dev npm run build` to point at the local emulator.
export const USE_EMULATOR =
  typeof process !== 'undefined' &&
  process.env &&
  process.env.PROSCAN_ENV === 'dev';

export const EMULATOR = { host: '127.0.0.1', authPort: 9099, firestorePort: 8080 };
