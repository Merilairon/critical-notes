/** Where the browser tests find the app, and the first-run admin they create. */
export const BASE_URL = process.env.E2E_BASE ?? 'http://localhost:3210';
export const DM = { username: 'jan', displayName: 'Jan', password: 'super secret pw' };
/** The admin's signed-in session, written by `auth.setup.ts`. */
export const DM_STATE = 'e2e/.auth/dm.json';

/**
 * The phone project runs on its OWN server (own data folder, own port): sign-up is limited to 8 per minute per
 * address and the desktop run already uses all 8, so a second project on the same server would be refused.
 * `E2E_PHONE_BASE=<url>` points it at another fresh instance (needed together with `E2E_BASE`).
 */
export const PHONE_BASE_URL = process.env.E2E_PHONE_BASE ?? (process.env.E2E_BASE ? undefined : 'http://localhost:3211');
export const PHONE_DM_STATE = 'e2e/.auth/dm-phone.json';

/**
 * A phone as the browser emulates it (Chrome device emulation, not a real device): 390x844 CSS px, touch, mobile
 * user agent, device scale factor 2. Not covered: iOS Safari zooming into inputs below 16 px, the notch and safe
 * areas, the on-screen keyboard resizing the viewport. Those need a real device.
 */
export const PHONE_DEVICE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
} as const;
