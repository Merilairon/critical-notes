/**
 * How to run the admin command line, in the two forms people use. Kept dependency-free: `restore-marker.ts` (which `main.ts` loads
 * before it touches anything) and the CLI texts both use it, so the program path is written down in exactly one place.
 *   bare install: from the repository folder, after `pnpm build`
 *   Docker: in a temporary container (works whether or not the app container exists; for `restore` stop the app first)
 */
export const BARE_ADMIN = 'node apps/server/dist/admin.mjs';
export const DOCKER_ADMIN = 'docker compose run --rm app node admin.mjs';

/** Both ways to run `args`, as two indented lines (`Docker:` first, as the other messages do). */
export function adminCommandLines(args: string, indent = '    '): string[] {
  return [`${indent}Docker:       ${DOCKER_ADMIN} ${args}`, `${indent}Bare install: ${BARE_ADMIN} ${args}   (from the repository folder)`];
}

/** One sentence form for running text: "Docker: ...; bare install: ...". */
export function adminCommandInline(args: string): string {
  return `Docker: ${DOCKER_ADMIN} ${args}; bare install: ${BARE_ADMIN} ${args}`;
}

/** Starting the server again after a restore (works whether or not the container exists). */
export const START_SERVER_HINT = 'Docker: docker compose up -d (works whether or not the container exists). Bare install: start the server again the way you normally do.';
