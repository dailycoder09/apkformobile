import { initializeApp } from 'firebase/app'

// Web SDK config for the "familyKit" Firebase project (familykit-dd384). This is
// separate from client/android/app/google-services.json (Android-only) -- the
// @capacitor-firebase/authentication plugin's web implementation needs this
// initialized before any FirebaseAuthentication.* call, or phone auth silently
// fails when the app runs in a plain browser (local dev/testing) instead of the
// native Android shell.
const firebaseConfig = {
  apiKey: 'AIzaSyApGEq11qYo_qbqKCEsVykosWkl4J2ciao',
  authDomain: 'familykit-dd384.firebaseapp.com',
  projectId: 'familykit-dd384',
  storageBucket: 'familykit-dd384.firebasestorage.app',
  messagingSenderId: '1002001889933',
  appId: '1:1002001889933:web:b309f92967839a89db40c4',
}

initializeApp(firebaseConfig)
