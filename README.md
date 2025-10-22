# flow

Minimal frontend for exchanging files and a small local-server emulator.

Usage (local)
- Start: node local-server.js 8787 ./local_storage
- Open: http://localhost:8787/

Deploy (brief)
- Frontend: GitHub Pages (workflow available).
- Backend: Cloudflare Workers + R2 (worker and R2 bucket named `flow`).

Required repository secrets for CI
- FRONTEND_PASSWORD (optional)
- CF_API_TOKEN
- CF_ACCOUNT_ID
