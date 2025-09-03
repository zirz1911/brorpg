  import React, { useEffect, useMemo, useRef, useState } from "react";
  import { DragDropContext, Droppable, Draggable, DropResult } from "@hello-pangea/dnd";
  import { initializeApp, getApps, FirebaseApp } from "firebase/app";
  import { getFirestore, doc, getDoc, setDoc, onSnapshot } from "firebase/firestore";
  import {
    getAuth,
    signInAnonymously,
    onAuthStateChanged,
    type User,
    type Auth,
    initializeAuth,
    browserLocalPersistence,
  } from "firebase/auth";

  type QuestType = "MAIN" | "SIDE";
  type Quest = { id: string; title: string; type: QuestType; notes?: string; createdAt: number; doneAt?: number; dueAt?: number };
  type Column = { id: string; title: string; questIds: string[] };
  type BoardState = { quests: Record<string, Quest>; columns: Record<string, Column>; updatedAt?: number; owner?: string };
  type SafeUser = User & { _localFallback?: boolean };

  const EMBEDDED_FIREBASE_CONFIG = {
    apiKey: "AIzaSyDxzWPu4BN4oWlPmYThBK16kuRejk_pdDY",
    authDomain: "bro-rpg.firebaseapp.com",
    projectId: "bro-rpg",
    appId: "1:1076788770767:web:d0d486ba73e5aa35f6c4ba",
  };

  const STORAGE_KEY = "bro-quest-board-v1";
  const FIREBASE_DOC_KEY = "bro-firebase-doc-id";
  const isBrowser = typeof window !== "undefined" && typeof localStorage !== "undefined";
  const uid = () => Math.random().toString(36).slice(2, 10);
  const daysBetween = (a: number, b: number) => Math.floor(Math.abs(a - b) / (1000 * 60 * 60 * 24));
  const formatDate = (ts?: number) => (ts ? new Date(ts).toLocaleDateString() : "—");

  function computeStats(quests: Record<string, Quest>) {
    const doneExp = Object.values(quests).reduce((acc, q) => (q.doneAt ? acc + (q.type === "MAIN" ? 200 : 50) : acc), 0);
    const overdue = Object.values(quests).filter((q) => !q.doneAt && daysBetween(q.createdAt, Date.now()) > 14);
    const penalties = overdue.length * 100;
    const activeMainCount = Object.values(quests).filter((q) => q.type === "MAIN" && !q.doneAt).length;
    const overwhelmed = activeMainCount > 2;
    const netExp = Math.max(0, doneExp - penalties);
    const level = Math.max(1, Math.floor(netExp / 500) + 1);
    let rewardTier = "Level 1–5: You may start a new project";
    if (level >= 6 && level <= 10) rewardTier = "Level 6–10: Buy a new tool/plugin";
    if (level >= 11) rewardTier = "Level 11+: Unlock a new class (Unity/Blender/etc.)";
    return { exp: netExp, penalties, activeMainCount, level, rewardTier, overwhelmed };
  }

  // --- RPG Profile helpers ---
  function levelProgress(exp: number, level: number) {
    const start = (level - 1) * 500;
    const next = level * 500;
    const span = Math.max(1, next - start);
    const pct = Math.max(0, Math.min(1, (exp - start) / span));
    return { start, next, pct };
  }
  function rankMeta(level: number) {
    if (level >= 11) return { emoji: "🐉", ring: "from-purple-500 to-fuchsia-500", title: "Dragonlord" };
    if (level >= 6) return { emoji: "⚔️", ring: "from-indigo-500 to-cyan-500", title: "Champion" };
    return { emoji: "🗡️", ring: "from-amber-500 to-rose-500", title: "Adventurer" };
  }

  function seedBoard(): BoardState {
    const now = Date.now();
    const quests: Record<string, Quest> = {
      q_main_aff: { id: "q_main_aff", title: "Main: Affiliate App", type: "MAIN", createdAt: now },
      q_main_gem: { id: "q_main_gem", title: "Main: Gem Search App", type: "MAIN", createdAt: now },
      q_side_fix: { id: "q_side_fix", title: "Side: Fix VS Code", type: "SIDE", createdAt: now },
      q_side_csv: { id: "q_side_csv", title: "Side: Add CSV export", type: "SIDE", createdAt: now },
    };
    const columns: Record<string, Column> = {
      backlog: { id: "backlog", title: "Backlog", questIds: ["q_side_fix", "q_side_csv"] },
      doing: { id: "doing", title: "In Progress", questIds: ["q_main_aff", "q_main_gem"] },
      done: { id: "done", title: "Done", questIds: [] },
    };
    return { quests, columns };
  }

  function ensureFirebase(cfg: any): FirebaseApp {
    const apps = getApps();
    return apps.length ? apps[0]! : initializeApp(cfg);
  }
function ensureAuth(app: FirebaseApp): Auth {
  // Use standard web auth initialization to avoid double-init and unexpected errors
  return getAuth(app);
}
async function ensureAuthSafe(app: FirebaseApp): Promise<SafeUser> {
  const auth = ensureAuth(app);
  try {
    if (auth.currentUser) return auth.currentUser as SafeUser;
    // Try sign-in directly and return the signed-in user
    const cred = await signInAnonymously(auth);
    return cred.user as SafeUser;
  } catch (e) {
    // Surface the auth error to callers; do not fabricate a local uid
    throw e;
  }
}
  function useDebouncedCallback<T extends (...args: any[]) => void>(cb: T, delay: number) {
    const t = useRef<number | null>(null);
    return (...args: Parameters<T>) => { if (t.current) window.clearTimeout(t.current); t.current = window.setTimeout(() => cb(...args), delay); };
  }

  export default function App() {
    const [docId, setDocId] = useState<string>(() => (isBrowser ? localStorage.getItem(FIREBASE_DOC_KEY) || "br" : "br"));
    const [cloudStatus, setCloudStatus] = useState<"idle" | "ready" | "saving" | "error" | "offline">("idle");
    const [cloudMsg, setCloudMsg] = useState<string>("");
    const [authInfo, setAuthInfo] = useState<string>("(auth: unknown)");
    const [docPath, setDocPath] = useState<string>("");
    const [quests, setQuests] = useState<Record<string, Quest>>(() => seedBoard().quests);
    const [columns, setColumns] = useState<Record<string, Column>>(() => seedBoard().columns);
    // Prevent clobbering Firestore with seeded data on first mount
    const hasLoadedFromCloud = useRef(false);

    useEffect(() => { if (isBrowser) localStorage.setItem(STORAGE_KEY, JSON.stringify({ quests, columns })); }, [quests, columns]);
    useEffect(() => { if (isBrowser) localStorage.setItem(FIREBASE_DOC_KEY, docId); }, [docId]);

    const columnOrder = ["backlog", "doing", "done"] as const;
    const { exp, penalties, activeMainCount, level, rewardTier, overwhelmed } = useMemo(() => computeStats(quests), [quests]);

    // --- Save helpers & explicit force-save feedback ---
    const [forceState, setForceState] = useState<'idle' | 'saving' | 'done'>('idle');

    async function performSave(state: BoardState) {
      try {
        const app = ensureFirebase(EMBEDDED_FIREBASE_CONFIG);
        let user: SafeUser;
        try {
          user = await ensureAuthSafe(app);
          setAuthInfo(`UID: ${user.uid}`);
        } catch (e: any) {
          setCloudStatus('error');
          setCloudMsg(e?.message || 'Auth failed: enable Anonymous sign-in in Firebase Console');
          setAuthInfo('no-auth');
          return; // abort save when not authenticated
        }
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          setCloudStatus('offline');
          setCloudMsg('Offline: changes kept locally');
          return;
        }
        setCloudStatus('saving');
        const db = getFirestore(app);
        const ref = doc(db, 'boards', `${docId}`);
        setDocPath(`boards/${docId}`);
        await setDoc(ref, { ...state, updatedAt: Date.now(), owner: user.uid }, { merge: true });
        setCloudStatus('ready');
        setCloudMsg('Synced to Firebase');
      } catch (e: any) {
        setCloudStatus('error');
        setCloudMsg(e?.code === 'permission-denied' ? 'permission-denied (check Auth & rules)' : (e?.message || 'Firebase save failed'));
      }
    }

    const debouncedSave = useDebouncedCallback(async (state: BoardState) => {
      await performSave(state);
    }, 600);
    useEffect(() => {
      if (!hasLoadedFromCloud.current) return; // skip initial seed write
      debouncedSave({ quests, columns });
    }, [quests, columns]);

    useEffect(() => {
      let unsub: (() => void) | null = null;
      (async () => {
        try {
          const app = ensureFirebase(EMBEDDED_FIREBASE_CONFIG);
          let user: SafeUser;
          try {
            user = await ensureAuthSafe(app);
            setAuthInfo(`UID: ${user.uid}`);
          } catch (e: any) {
            setCloudStatus("error");
            setCloudMsg(e?.message || "Auth failed: enable Anonymous sign-in in Firebase Console");
            setAuthInfo("no-auth");
            return; // don't attempt Firestore without auth
          }
          const db = getFirestore(app);
          const ref = doc(db, "boards", `${docId}`);
          setDocPath(`boards/${docId}`);
          const snap = await getDoc(ref);
          if (!snap.exists()) {
            // One-time migration: if an old per-UID doc exists, copy it to the new shared docId path
            const oldRef = doc(db, "boards", `${user.uid}-${docId}`);
            const oldSnap = await getDoc(oldRef);
            if (oldSnap.exists()) {
              await setDoc(ref, { ...oldSnap.data(), migratedFrom: `${user.uid}-${docId}`, updatedAt: Date.now() }, { merge: true });
            } else {
              await setDoc(ref, { ...seedBoard(), owner: user.uid, updatedAt: Date.now() }, { merge: true });
            }
          } else {
            const data = snap.data() as BoardState;
            if (data?.quests && data?.columns) {
              setQuests(data.quests);
              setColumns(data.columns);
            }
          }
          // After initial get, allow future saves
          hasLoadedFromCloud.current = true;

          unsub = onSnapshot(ref, (ds) => {
            const d = ds.data() as BoardState | undefined;
            if (d?.quests && d?.columns) {
              setQuests(d.quests);
              setColumns(d.columns);
              setCloudStatus("ready");
              setCloudMsg("Realtime: Live");
            }
          });
        } catch (e: any) {
          setCloudStatus("error"); setCloudMsg(e?.message || "Realtime subscribe failed");
        }
      })();
      return () => { if (unsub) unsub(); };
    }, [docId]);

    function addQuest(type: QuestType, columnId: string) {
      const id = `q_${uid()}`; const title = type === "MAIN" ? "Main: New Quest" : "Side: New Task";
      const q: Quest = { id, type, title, createdAt: Date.now() };
      setQuests((prev) => ({ ...prev, [id]: q }));
      setColumns((prev) => ({ ...prev, [columnId]: { ...prev[columnId], questIds: [id, ...prev[columnId].questIds] } }));
    }
    function updateQuestTitle(id: string, title: string) { setQuests((prev) => ({ ...prev, [id]: { ...prev[id], title } })); }
    function deleteQuest(id: string) {
      setColumns((prev) => { const clone = { ...prev }; Object.values(clone).forEach(c => c.questIds = c.questIds.filter(x => x !== id)); return clone; });
      setQuests((prev) => { const { [id]: _, ...rest } = prev; return rest; });
    }
    function onDragEnd(result: DropResult) {
      const { source, destination, draggableId } = result; if (!destination) return;
      if (destination.droppableId === source.droppableId && destination.index === source.index) return;
      const start = columns[source.droppableId]; const finish = columns[destination.droppableId];
      if (start === finish) {
        const newIds = Array.from(start.questIds); newIds.splice(source.index, 1); newIds.splice(destination.index, 0, draggableId);
        setColumns({ ...columns, [start.id]: { ...start, questIds: newIds } }); return;
      }
      const startIds = Array.from(start.questIds); startIds.splice(source.index, 1);
      const finishIds = Array.from(finish.questIds); finishIds.splice(destination.index, 0, draggableId);
      setColumns({ ...columns, [start.id]: { ...start, questIds: startIds }, [finish.id]: { ...finish, questIds: finishIds } });
      if (finish.id === "done" && !quests[draggableId].doneAt) setQuests((p) => ({ ...p, [draggableId]: { ...p[draggableId], doneAt: Date.now() } }));
      if (start.id === "done" && quests[draggableId].doneAt) setQuests((p) => ({ ...p, [draggableId]: { ...p[draggableId], doneAt: undefined } }));
    }

    // Self-tests (kept minimal)
    type Test = { name: string; pass: boolean };
    const tests: Test[] = useMemo(() => {
      const now = Date.now();
      const base: Record<string, Quest> = { a: { id: "a", title: "M", type: "MAIN", createdAt: now }, b: { id: "b", title: "S", type: "SIDE", createdAt: now } };
      const t1 = computeStats(base); const T1 = { name: "T1 no-done no-penalty", pass: t1.exp === 0 && t1.penalties === 0 };
      const t2 = computeStats({ ...base, a: { ...base.a, doneAt: now } }); const T2 = { name: "+200 main done", pass: t2.exp === 200 };
      const old = now - 15 * 24 * 60 * 60 * 1000; const t3 = computeStats({ x: { id: "x", title: "S", type: "SIDE", createdAt: old } });
      const T3 = { name: "-100 overdue", pass: t3.penalties === 100 && t3.exp === 0 };
      return [T1, T2, T3];
    }, []);

    return (
      <div className="min-h-screen w-full bg-neutral-100 text-neutral-900">
        <div className="mx-auto max-w-7xl px-4 py-6">
          <div className="flex items-end justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Bro’s Quest Board</h1>
              <p className="text-sm text-neutral-600">Realtime Firebase sync • Anonymous Auth or local fallback</p>
            </div>
            {/* RPG Profile Card */}
            <div className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3 shadow-sm">
              {(() => { const m = rankMeta(level); return (
                <div className="relative">
                  <div className={`h-12 w-12 rounded-full bg-gradient-to-br ${m.ring} p-[2px]`}> 
                    <div className="flex h-full w-full items-center justify-center rounded-full bg-white text-xl">{m.emoji}</div>
                  </div>
                  <div className="absolute -bottom-1 -right-1 rounded-md bg-black/80 px-1.5 py-0.5 text-[10px] font-bold text-white">Lv {level}</div>
                </div>
              ); })()}
              <div className="min-w-[12rem]">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <span>Bro Pajipan</span>
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-neutral-700">{rankMeta(level).title}</span>
                </div>
                <div className="mt-1 text-[12px] text-neutral-600">Reward: {rewardTier}</div>
                {(() => { const p = levelProgress(exp, level); return (
                  <div className="mt-2">
                    <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200">
                      <div className="h-full bg-gradient-to-r from-emerald-400 to-emerald-600" style={{ width: `${p.pct * 100}%` }} />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-neutral-500">
                      <span>EXP {exp}{penalties>0 && <span className="text-red-600"> (−{penalties})</span>}</span>
                      <span>Next: {p.next}</span>
                    </div>
                  </div>
                ); })()}
              </div>
            </div>
          </div>
          {overwhelmed && (<div className="mt-3 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">Debuff: Overwhelmed — keep MAIN ≤ 2 (now {activeMainCount}).</div>)}
          <details className="mt-2 text-xs text-neutral-500">
            <summary className="cursor-pointer select-none">Cloud Firebase Status: </summary>
            <div className="mt-1 pl-4">
              <div>{cloudMsg || cloudStatus} {authInfo}</div>
              {docPath && <div>doc: {docPath}</div>}
            </div>
          </details>
        </div>
        <div className="mx-auto max-w-7xl px-4 pb-10">
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
            <label className="font-semibold">Board ID</label>
            <input className="rounded border px-2 py-1" value={docId} onChange={(e)=>setDocId(e.target.value || "br")} />
            <button
              onClick={async () => {
                if (forceState === 'saving') return;
                setForceState('saving');
                await performSave({ quests, columns });
                setForceState('done');
                setTimeout(() => setForceState('idle'), 1200);
              }}
              aria-busy={forceState === 'saving'}
              disabled={forceState === 'saving'}
              className={
                `rounded px-3 py-1 text-sm border transition ` +
                (forceState === 'saving' ? 'opacity-70 cursor-wait' : '') +
                (forceState === 'done' ? ' border-emerald-300 bg-emerald-50 text-emerald-700' : ' hover:bg-neutral-50')
              }
            >
              {forceState === 'idle' && 'Force Save'}
              {forceState === 'saving' && (
                <span className="inline-flex items-center gap-2">
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border border-neutral-400 border-t-transparent" />
                  Saving…
                </span>
              )}
              {forceState === 'done' && (
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block">✓</span>
                  Saved
                </span>
              )}
            </button>
            <button onClick={()=>location.reload()} className="rounded border px-2 py-1">Reload</button>
            {docPath && <span className="opacity-70">path: {docPath}</span>}
          </div>
          <DragDropContext onDragEnd={onDragEnd}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {columnOrder.map((colId) => {
                const column = columns[colId];
                const items = (column?.questIds || []).map((id) => quests[id]).filter(Boolean);
                return (
                  <Droppable droppableId={colId} key={colId}>
                    {(provided, snapshot) => (
                      <div ref={provided.innerRef} {...provided.droppableProps}
                        className={`rounded-2xl p-3 md:p-4 transition shadow ${snapshot.isDraggingOver ? "bg-indigo-50" : "bg-white"}`}>
                        <div className="mb-3 flex items-center justify-between">
                          <h2 className="text-lg font-bold">{column?.title || colId}</h2>
                          <div className="flex gap-2">
                            <button onClick={() => addQuest("SIDE", colId)} className="rounded-xl border px-3 py-1 text-sm hover:bg-neutral-50">+ Side</button>
                            <button onClick={() => addQuest("MAIN", colId)} className="rounded-xl border px-3 py-1 text-sm hover:bg-neutral-50">+ Main</button>
                          </div>
                        </div>
                        <div className="flex flex-col gap-3">
                          {items.map((q, index) => (
                            <Draggable draggableId={q.id} index={index} key={q.id}>
                              {(provided, snapshot) => (
                                <div ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps}
                                  className={`rounded-xl border p-3 shadow-sm bg-white ${snapshot.isDragging ? "ring-2 ring-indigo-300" : ""}`}>
                                  <div className="flex items-start justify-between gap-2">
                                    <input value={q.title} onChange={(e) => updateQuestTitle(q.id, e.target.value)}
                                      className="w-full rounded-lg border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300" />
                                    <span className={`select-none rounded-md px-2 py-0.5 text-[11px] font-bold ${q.type === "MAIN" ? "bg-indigo-100 text-indigo-700" : "bg-emerald-100 text-emerald-700"}`}>{q.type}</span>
                                  </div>
                                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-600">
                                    <span className="rounded bg-neutral-100 px-2 py-0.5">Created: {formatDate(q.createdAt)}</span>
                                    <span className="rounded bg-neutral-100 px-2 py-0.5">Done: {formatDate(q.doneAt)}</span>
                                    {!q.doneAt && daysBetween(q.createdAt, Date.now()) > 14 && (<span className="rounded bg-red-100 px-2 py-0.5 text-red-700">Overdue: -100 EXP</span>)}
                                  </div>
                                  <div className="mt-3 flex justify-between">
                                    <button onClick={() => deleteQuest(q.id)} className="text-xs rounded-lg border px-2 py-1 hover:bg-neutral-50">Delete</button>
                                    {colId !== "done" && (
                                      <button onClick={() => {
                                        setColumns((prev) => { const current = prev[colId]; const done = prev["done"]; 
                                          const newCurrentIds = current.questIds.filter((x) => x !== q.id);
                                          const newDoneIds = [q.id, ...done.questIds];
                                          return { ...prev, [colId]: { ...current, questIds: newCurrentIds }, done: { ...done, questIds: newDoneIds } } as any; });
                                        if (!q.doneAt) setQuests((prev) => ({ ...prev, [q.id]: { ...prev[q.id], doneAt: Date.now() } }));
                                      }} className="text-xs rounded-lg border px-2 py-1 hover:bg-neutral-50">Mark Done &rarr;</button>
                                    )}
                                  </div>
                                </div>
                              )}
                            </Draggable>
                          ))}
                          {provided.placeholder}
                        </div>
                      </div>
                    )}
                  </Droppable>
                );
              })}
            </div>
          </DragDropContext>
          <details className="mt-6 rounded-xl bg-white p-4 shadow">
            <summary className="cursor-pointer text-sm font-semibold select-none">Self-tests</summary>
            <div className="mt-2 grid gap-2">
              {tests.map((t, i) => (
                <div key={i} className="flex items-center justify-between rounded border px-3 py-2 text-xs">
                  <span>{t.name}</span>
                  <span className={t.pass ? "text-emerald-700" : "text-red-700"}>{t.pass ? "PASS" : "FAIL"}</span>
                </div>
              ))}
            </div>
          </details>
          <details className="mx-auto mt-4 max-w-7xl rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            <summary className="cursor-pointer font-semibold select-none">Troubleshooting: “Missing or insufficient permissions”</summary>
            <ol className="list-decimal pl-5 mt-2 space-y-1">
              <li>Enable <b>Anonymous</b> sign-in in Firebase Console → Auth → Sign-in method.</li>
              <li>Firestore Rules (quick start):
                <pre className="mt-1 rounded bg-white p-2 overflow-auto">{`service cloud.firestore {
  match /databases/{database}/documents {
    match /boards/{doc} {
      allow read, write: if request.auth != null;
    }
  }
}`}</pre>
              </li>
            </ol>
          </details>
        </div>
      </div>
    );
  }
