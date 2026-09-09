import { createHttpClient } from './http.js';
import { createFixtureClient } from './fixture.js';

/** Fixture mode: `VITE_SBB_FIXTURE=1 npm run dev` (or build) renders without `sbb ui`. */
export const FIXTURE = import.meta.env.VITE_SBB_FIXTURE === '1';

export function createClient() {
  return FIXTURE ? createFixtureClient() : createHttpClient();
}
