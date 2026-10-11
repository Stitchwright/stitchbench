# stitchsite: the website for StitchBench and StitchShop

The public website at https://stitchbench.app: what the programs do, how to install and set them up, and where to
sign up. A static site: Next.js 16 with `output: "export"`, Tailwind 4 and TypeScript; sign-up and accounts live on
the community hub, which this site only links to.

```bash
npm install
npm run dev       # http://localhost:3000
npm run build     # writes the whole site to out/
npm run verify    # typecheck, lint, build and a check of every internal link
```

Every address, price and name the pages use is in `src/lib/site.ts`. `stitchshop.app` forwards to `/stitchshop/`
through `functions/_middleware.js` (Cloudflare Pages).

The programs themselves are free software: https://github.com/{{ORG}}/stitchbench (StitchBench and StitchShop) and
https://github.com/{{ORG}}/stitchhub (the community hub).

## License

The site's code is MIT (LICENSE). Its words, screenshots, pictures and logos, and the product names, are
Copyright (c) {{YEAR}} {{HOLDER}}, all rights reserved (TRADEMARKS.md).
