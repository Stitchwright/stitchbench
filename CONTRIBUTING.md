# Contributing

Thanks for helping. Bug reports and small fixes are welcome; for anything bigger, open an issue first so we can agree
on the approach.

## Setup

```
docker compose up -d            # Postgres for development (port 5433)
cp .env.example .env            # set AUTH_SECRET
npm ci
npx prisma migrate deploy && npm run db:seed
npm run dev
```

More in the README ("Run it for development" and "Tests").

## Before you open a pull request

CI runs these; run them locally first:

```
npx tsc --noEmit
npm run lint
npm run test:unit
```

The Windows/Mac/Linux program's database code has its own tests: `cd desktop && npm test` (needs a Postgres,
`TEST_DATABASE_URL`).

## Conventions

- Every business query filters by the signed-in user's `shopId` (`requireUser()` in `src/lib/session.ts`). Check
  ownership before touching a row by id.
- Server actions live in `src/actions/`, wrapped with `safe()`; throw `UserError` for anything the user can fix.
- Money is integer cents. Tension values are grams-force.
- Keep a change focused, and add a check or test where there is one for that area.

## Licence

By contributing you agree your work is licensed as the project is: MIT OR Apache-2.0.
