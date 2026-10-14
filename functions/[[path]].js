/* ---------------------------------------------------------------------------
 * The Pages Function this dashboard is served by.
 *
 * Pages is this site's only host. `functions/[[path]].js` is the catch-all
 * route, so every request arrives here, and the router it imports -
 * `_router.js` - does the work: it answers the public `/data/*.json` API (the
 * contract `public/_redirects` records), stores each of those responses in the
 * colo cache under the policy the handler asked for, and hands everything else
 * to `env.ASSETS`, which serves `public/`.
 *
 * The assets live in `public/`, not at the repository root, and that is where
 * this directory sits: Pages compiles `functions/` from the project's build root
 * (the repository) and uploads the staged `public/` as the site.
 *
 * Why two files rather than one: Pages compiles every file in this directory as
 * a route, and only the entry needs to be one. `_router.js` carries the
 * underscore prefix Pages treats as private - a module, never a path of its own
 * - so the routing table is exactly the one catch-all below.
 *
 * This is what replaced the Workers deployment: the same handler used to be
 * bundled into a Worker script (sixteen functions as one) and staged as the
 * deployment's `_worker.js`. Pages compiles it itself now, minus the bundle step
 * and the second config.
 * ------------------------------------------------------------------------ */
import router from './_router.js';

export const onRequest = (context) => router.fetch(context.request, context.env, context);
