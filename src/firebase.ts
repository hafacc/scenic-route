import { type FirebaseApp, initializeApp } from "firebase/app";
import {
  type Auth,
  getAuth,
  onIdTokenChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import {
  addDoc,
  type CollectionReference,
  collection,
  deleteDoc,
  doc,
  type Firestore,
  type FirestoreError,
  initializeFirestore,
  limit,
  onSnapshot,
  orderBy,
  persistentLocalCache,
  persistentMultipleTabManager,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  waitForPendingWrites,
} from "firebase/firestore";
import { type Feedback, feedbackConverter } from "./feedback";
import { type Pin, type PinDraft, pinConverter } from "./pin";

const firebaseConfig = {
  apiKey: "AIzaSyCUNeUTKnRphdhQ-QdR3-7-sACkaJqVPwU",
  authDomain: "hafaio-scenic-route.firebaseapp.com",
  projectId: "hafaio-scenic-route",
  storageBucket: "hafaio-scenic-route.firebasestorage.app",
  messagingSenderId: "988452416366",
  appId: "1:988452416366:web:1f265001362929a156ef7f",
};

const PINS = "pins";
const FEEDBACK = "feedback";

// Older notes stay reachable in the Firebase console.
const FEEDBACK_LIMIT = 200;

export interface AuthInfo {
  user: User;
  admin: boolean;
}

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;

function ensureApp(): FirebaseApp {
  if (!app) {
    app = initializeApp(firebaseConfig);
  }
  return app;
}

function ensureAuth(): Auth {
  if (!authInstance) {
    authInstance = getAuth(ensureApp());
  }
  return authInstance;
}

function ensureDb(): Firestore {
  if (!dbInstance) {
    dbInstance = initializeFirestore(ensureApp(), {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  }
  return dbInstance;
}

// onIdTokenChanged, not onAuthStateChanged, so an admin promotion lands without re-login.
export function watchAuth(
  callback: (info: AuthInfo | null) => void,
): () => void {
  let latestInvocation = 0;
  return onIdTokenChanged(ensureAuth(), async (user) => {
    const invocation = ++latestInvocation;
    if (!user) {
      callback(null);
      return;
    }
    let admin = false;
    try {
      const result = await user.getIdTokenResult();
      admin = result.claims.admin === true;
    } catch {}
    // A late token fetch must not revive a signed-out session.
    if (invocation !== latestInvocation) {
      return;
    }
    callback({ user, admin });
  });
}

export async function signIn(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(ensureAuth(), email, password);
}

export async function signOutUser(): Promise<void> {
  await signOut(ensureAuth());
}

export async function sendPasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(ensureAuth(), email);
}

// Picks up a newly granted admin claim without re-login; watchAuth then re-fires.
export async function refreshClaims(): Promise<void> {
  const user = ensureAuth().currentUser;
  if (!user) {
    return;
  }
  await user.getIdToken(true);
}

// Per-uid and optional: the app works signed out and keeps working if this never loads.
const SETTINGS = "settings";

function settingsDoc(uid: string) {
  return doc(ensureDb(), SETTINGS, uid);
}

// `undefined` until the first sync, which is not an error.
export function watchSettings(
  uid: string,
  callback: (document: unknown | undefined) => void,
  onError?: (error: FirestoreError) => void,
): () => void {
  return onSnapshot(
    settingsDoc(uid),
    (snapshot) => {
      callback(snapshot.data());
    },
    (error) => {
      onError?.(error);
    },
  );
}

export async function writeSettings(
  uid: string,
  document: object,
): Promise<void> {
  await setDoc(settingsDoc(uid), document);
}

function rawPinsCollection(): CollectionReference {
  return collection(ensureDb(), PINS);
}

function pinsCollection() {
  return rawPinsCollection().withConverter(pinConverter);
}

export function watchPins(
  callback: (pins: Pin[]) => void,
  onError?: (error: FirestoreError) => void,
): () => void {
  const q = query(pinsCollection(), orderBy("modifiedAt", "desc"));
  return onSnapshot(
    q,
    (snapshot) => {
      // "estimate" so fresh pins don't surface with null timestamps before the server acks.
      callback(
        snapshot.docs.map((docSnap) =>
          docSnap.data({ serverTimestamps: "estimate" }),
        ),
      );
    },
    (error) => {
      onError?.(error);
    },
  );
}

export async function createPin(uid: string, draft: PinDraft): Promise<string> {
  const ref = await addDoc(rawPinsCollection(), {
    lat: draft.lat,
    lng: draft.lng,
    address: draft.address,
    text: draft.text,
    creator: uid,
    createdAt: serverTimestamp(),
    lastModifier: uid,
    modifiedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updatePin(
  uid: string,
  pinId: string,
  fields: Partial<Pick<PinDraft, "text" | "address" | "lat" | "lng">>,
): Promise<void> {
  const ref = doc(rawPinsCollection(), pinId);
  await updateDoc(ref, {
    ...fields,
    lastModifier: uid,
    modifiedAt: serverTimestamp(),
  });
}

export async function deletePin(pinId: string): Promise<void> {
  const ref = doc(rawPinsCollection(), pinId);
  await deleteDoc(ref);
}

function rawFeedbackCollection(): CollectionReference {
  return collection(ensureDb(), FEEDBACK);
}

// Firestore drains its queue only once built, so this tells a later launch to open a connection.
const PENDING_FEEDBACK_KEY = "scenic-route:feedback-pending";

// A browser can refuse storage outright, and a note that can't be bookkept is still worth sending.
function markPendingFeedback(pending: boolean): void {
  try {
    if (pending) {
      window.localStorage.setItem(PENDING_FEEDBACK_KEY, "1");
    } else {
      window.localStorage.removeItem(PENDING_FEEDBACK_KEY);
    }
  } catch {}
}

function feedbackPending(): boolean {
  try {
    return window.localStorage.getItem(PENDING_FEEDBACK_KEY) !== null;
  } catch {
    return false;
  }
}

// Clears on an empty queue, not on one note's ack, or a second in-flight note would never flush.
async function clearPendingWhenDrained(): Promise<void> {
  await waitForPendingWrites(ensureDb());
  markPendingFeedback(false);
}

// Offline writes queue in the persistent cache, so a rejection means the rules refused it.
export async function sendFeedback(text: string): Promise<void> {
  markPendingFeedback(true);
  try {
    await addDoc(rawFeedbackCollection(), {
      text,
      createdAt: serverTimestamp(),
    });
  } finally {
    await clearPendingWhenDrained();
  }
}

// waitForPendingWrites starts the connection and resolves once drained; offline, the flag waits.
export async function flushPendingFeedback(): Promise<void> {
  if (feedbackPending()) {
    await clearPendingWhenDrained();
  }
}

export function watchFeedback(
  callback: (notes: Feedback[]) => void,
  onError?: (error: FirestoreError) => void,
): () => void {
  // One order field, so no composite index is needed.
  const newest = query(
    rawFeedbackCollection().withConverter(feedbackConverter),
    orderBy("createdAt", "desc"),
    limit(FEEDBACK_LIMIT),
  );
  return onSnapshot(
    newest,
    (snapshot) => {
      callback(
        snapshot.docs.map((docSnap) =>
          docSnap.data({ serverTimestamps: "estimate" }),
        ),
      );
    },
    (error) => {
      onError?.(error);
    },
  );
}

// No undo: the sender can't see their note either, so this is the last copy.
export async function deleteFeedback(feedbackId: string): Promise<void> {
  await deleteDoc(doc(rawFeedbackCollection(), feedbackId));
}
