# AlphaMark Backend (skeleton)

This repository contains a small Express-based skeleton for the AlphaMark AI Recommendation System.

Quick start

1. Copy `.env.example` to `.env` and fill values (optional `OPENAI_API_KEY`, optional Supabase keys).

2. Install dependencies:

```powershell
cd "d:/Taupe/AI Recommendation System/alphamark-backend";
npm install
```

3. Run in development mode:

```powershell
npm run dev
```

API

- POST `/consultation` — body: `{ userProfile: {...}, concerns: ["acne","dry"] }`. Returns recommendations.

Notes

- If `OPENAI_API_KEY` is set, the backend will attempt to call OpenAI Chat Completions API. Otherwise it returns a deterministic mock list for local development.
- Supabase integration requires `SUPABASE_URL` and a key; if absent the app continues without persistence.
