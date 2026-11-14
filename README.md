# Skim

A static web RSS reader for **Miniflux** (native API) and **Google Reader API** servers (FreshRSS, Miniflux's GReader
endpoint, and others). There is no backend: the browser talks straight to your server, and connection details live in
the browser's local storage.

## Use

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm test           # unit tests
```

Host the `dist/` folder anywhere static (a sub-folder works; asset paths are relative and routing uses `#` URLs).
Choose **Try it with demo data** on the connect screen to look around without a server.

### GitHub Pages

`.github/workflows/deploy.yml` runs the tests, builds, and publishes to GitHub Pages on every push to `main`
(including merged pull requests). One-time setup: in the repository's **Settings → Pages**, set **Source** to
**GitHub Actions**. The site appears at `https://<user>.github.io/<repo>/`; allow that origin
(`https://<user>.github.io`) in your server's CORS settings.

### Server setup

Your server must allow cross-origin requests from wherever Skim is hosted, including the `Authorization` /
`X-Auth-Token` headers. If it doesn't, add the CORS headers in the reverse proxy in front of it, for example (Caddy):

```
header Access-Control-Allow-Origin "https://skim.example.com"
header Access-Control-Allow-Headers "Authorization, X-Auth-Token, Content-Type"
header Access-Control-Allow-Methods "GET, POST, PUT, OPTIONS"
```

…and answer `OPTIONS` preflight requests with `204`.

- **Miniflux:** use an API key (Settings → API Keys), or username and password.
- **FreshRSS:** enable the API in the admin settings, set an API password under Profile → API management, and use
  `https://your-host/api/greader.php` as the server URL. Skim keeps only the auth token the server returns, not the
  password.

## How it works

| Piece | Where |
| --- | --- |
| API clients behind one `Backend` interface | `src/api/miniflux.ts`, `src/api/greader.ts`, `src/api/demo.ts` |
| Data fetching, caching, optimistic read/star updates | `src/hooks/data.ts` (TanStack Query) |
| Virtualised list grouped by day | `src/components/ArticleList.tsx` (react-virtuoso) |
| Sidebar, phone drawer, resizable divider | `src/components/Sidebar.tsx`, `Reader.tsx`, `Resizer.tsx` |
| Theme tokens (light/dark, follows the system) | `src/index.css` |

Behaviour worth knowing:

- Lists are snapshots: items you mark read stay visible (dimmed) until you change view or refresh, so nothing jumps
  under the cursor. The sidebar keeps feeds listed for the same reason.
- **Read above / below** act on the articles loaded in the current view, in on-screen order.
- **Mark all read** marks the whole feed, category or everything on the server, then moves to the next feed or
  category that still has items under the current filter.
- Clicking a title opens the article in a new tab and marks it read.
