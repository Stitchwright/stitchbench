import path from "node:path";

/**
 * path.join that the bundler can't read as a file pattern. Turbopack traces `path.join(someDir, `${id}.json`)` with a
 * root it can't evaluate (os.tmpdir(), a setting) as "every .json file", and copies whatever matches into the
 * standalone build: the Windows app once grew from 150 MB to over 800 MB that way (the installer output, the previous
 * build, the docs). Going through a spread keeps the trace to the code. Use it for every runtime path built from a
 * folder the bundler can't know.
 */
export const under = (...parts: string[]): string => path.join(...parts.map(String));
