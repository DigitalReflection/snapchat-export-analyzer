# Snapchat Export Analyzer

A privacy-first web dashboard for reviewing Snapchat exports that an account owner willingly provides. The MVP is designed to run mostly in the browser so the app stays cheap to host and avoids storing sensitive uploads on a server by default.

## Cheap stack

- GitHub for source control, issues, and Actions
- React + Vite for the dashboard UI
- Firebase Hosting for a Google-hosted static deploy
- Optional Cloud Run service later for PDF generation, auth, or secured report sharing

## Why this architecture

- Lowest risk: export files can stay on the user device
- Lowest cost: static hosting is usually enough for the first release
- Easy to grow: add Cloud Run only when a browser-only workflow becomes limiting

## Current MVP

1. Accept a Snapchat export zip in the browser.
2. Parse supported JSON, CSV, HTML, and TXT files locally.
3. Normalize useful rows into chat, contact, location, search, login, and memory events.
4. Show signals for contact spikes, late-night activity, keyword matches, location overlap, and device changes.
5. Export normalized events as JSON plus contacts and keyword hits as CSV.

## Snapchat export coverage

Support these import paths first:

- Full `My Data` export
- Memories-only export

Keep these fields first:

- timestamps
- usernames and display names
- chat and snap metadata
- saved chat history
- location points
- search history
- login history and device changes
- memories metadata and optional media references

Discard or ignore these by default:

- Bitmoji data
- support history
- shop and purchase history
- cosmetic profile metadata
- duplicate previews and wrapper files

## Local development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

## Free hosting with GitHub Pages

This project is set up for free static hosting on GitHub Pages using GitHub Actions.

1. Create a GitHub repo and push this project to the `main` branch.
2. In GitHub, open `Settings` -> `Pages`.
3. Under `Build and deployment`, choose `GitHub Actions`.
4. Push to `main` and wait for the `Deploy to GitHub Pages` workflow to finish.
5. Your dashboard will be published at `https://<your-github-username>.github.io/<repo-name>/`.

The workflow file is already included at [.github/workflows/deploy-pages.yml](/C:/Users/Anon/Documents/Snapchat%20Spy/.github/workflows/deploy-pages.yml).

## Firebase Hosting deploy

1. Create a Firebase project in Google Cloud.
2. Install the CLI with `npm install -g firebase-tools`.
3. Run `firebase login`.
4. Run `firebase init hosting` and set `dist` as the public directory.
5. Build the app with `npm run build`.
6. Deploy with `firebase deploy`.

The repo already includes a starter [firebase.json](/C:/Users/Anon/Documents/Snapchat%20Spy/firebase.json) for SPA rewrites.

## Next build steps

- Add PDF, CSV, and JSON report export from the live dashboard
- Add editable keyword watchlists and saved review rules
- Add a richer timeline chart and correlation views
- Add optional Cloud Run endpoints for generated report files or auth
