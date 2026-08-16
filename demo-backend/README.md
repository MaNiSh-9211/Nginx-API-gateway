# demo-backend

**Dev-only repo** — sample upstream API + dev JWT minter. **Do not deploy to production.**

## Build

```bash
docker build -t demo-backend:latest .
```

TypeScript source lives in `src/`; Docker multi-stage build uses **TypeScript 7** (`typescript@rc` Go compiler).

## Run

```bash
npm start        # node dist/server.js
npm run dev      # tsc --watch + nodemon
```

Full stack: `../dev/README.md`

## Tests

```bash
npm test         # compiles + runs src/users.test.ts
```
