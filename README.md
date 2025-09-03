# Bro’s Quest Board — React + Firebase (Vite)

Trello-like Kanban with RPG rules, realtime Firestore sync, and Anonymous Auth.

## Quick start
```bash
npm i
npm run dev
```
Open the printed URL.

## Firebase setup
1. Create a Firebase project and a Web App. Copy the **client config** and replace the values in `src/App.tsx` (we ship a demo config).
2. Enable **Authentication → Anonymous** sign-in.
3. Firestore → Rules (starter):
```
service cloud.firestore {
  match /databases/{database}/documents {
    match /boards/{doc} {
      allow read, write: if request.auth != null;
    }
  }
}
```
Optional stricter owner-only rule (doc id format is `<uid>-<boardId>`):
```
allow read, write: if request.auth != null && request.auth.uid == doc.split('-')[0];
```

## Notes
- Tailwind via CDN (no build plugins).
- If Anonymous Auth is disabled, app falls back to local mode and shows that in the header.
