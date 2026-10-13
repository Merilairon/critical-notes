/** Where the browser tests find the app, and the first-run admin they create. */
export const BASE_URL = process.env.E2E_BASE ?? 'http://localhost:3210';
export const DM = { username: 'jan', displayName: 'Jan', password: 'super secret pw' };
/** The admin's signed-in session, written by `auth.setup.ts`. */
export const DM_STATE = 'e2e/.auth/dm.json';
