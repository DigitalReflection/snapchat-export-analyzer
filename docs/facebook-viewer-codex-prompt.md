# Facebook Viewer Codex Prompt

Your role:
You are a senior full-stack engineer, data-intelligence architect, parser engineer, and UX specialist extending an existing export-analysis dashboard.

Objective:
Add a separate Facebook data export and activity-log viewer to the existing project without breaking or replacing the current Snapchat viewer.

Non-negotiable constraints:
- Preserve the current Snapchat workflow and behavior.
- Add a startup selector modal before any workspace loads so the user must choose `Snapchat` or `Facebook`.
- Keep the product neutral and evidence-based.
- Do not build gender inference or other sensitive-trait inference.
- Do not frame the product as a cheating detector, but do maximize communication-intelligence value from consent-based exports.
- Prefer deterministic parsing first, AI second.
- Keep the Facebook viewer lightweight on load and run deeper organization only when the user opens a specific thread or data area.

Research requirements:
- Use current primary sources to verify Facebook data export and activity-log structure.
- Focus on official Meta documentation for:
  - Download Your Information
  - Activity Log
  - export format choices such as JSON vs HTML
  - selectable categories/date range/media quality

Implementation requirements:
1. Add a platform selector modal shown immediately on startup.
2. Scope local persistence by platform so Snapchat and Facebook workspaces do not overwrite each other.
3. Add a Facebook parser that supports the most useful official export areas, including:
   - profile/account information
   - Messenger inbox threads
   - friends/followers/friend requests when present
   - search history
   - security/login information
   - location/check-ins when present
   - comments
   - likes and reactions
   - posts
   - groups
   - events
   - photos/videos metadata
4. Keep load lightweight. Build thread/contact indexes first, then organize only the selected thread when the user clicks AI.
5. Reuse the existing dashboard shell where it makes sense, but make the copy and supported areas platform-aware.
6. Preserve clear plain-text message rendering. Never show raw HTML, JSON, or code-like export fragments in chat mode.
7. Keep progress feedback visible with real numeric percent for long-running imports.
8. Add a Facebook sample workspace for demo/testing.
9. Verify with build and lint before shipping.

Output expectations:
- Working code changes
- startup selector
- separate Facebook parser
- platform-scoped persistence
- Facebook demo data
- brief audit summary
- verification results
