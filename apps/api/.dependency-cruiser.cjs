// Architecture rules for the API (YGP-110), checked by dependency-cruiser:
//   pnpm --filter @ads/api arch
// Each provider SDK is imported in one folder only, so the rest of the API uses
// our own modules and a provider can be swapped in one place.
module.exports = {
  forbidden: [
    {
      name: "livekit-sdk-only-in-livekit",
      comment: "Only src/livekit talks to LiveKit; everything else uses its rooms and tokens.",
      severity: "error",
      from: { pathNot: "^src/livekit/" },
      to: { path: "livekit-server-sdk" },
    },
    {
      name: "redis-only-in-queue",
      comment: "Only src/queue talks to Redis; everything else uses the job queue.",
      severity: "error",
      from: { pathNot: "^src/queue/" },
      to: { path: "ioredis" },
    },
    {
      name: "routes-no-database",
      comment: "Routes call the session and track services, never the database or the repos.",
      severity: "error",
      from: { path: "^src/routes/" },
      to: { path: ["^src/db\.ts$", "/repo\.ts$", "(^|/)pg($|/)"] },
    },
    {
      name: "nothing-imports-routes",
      comment: "Only the app wires up the routes; lower layers never import them.",
      severity: "error",
      from: { pathNot: "^src/app\.ts$" },
      to: { path: "^src/routes/" },
    },
    {
      name: "no-circular",
      comment: "No import cycles.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    // TypeScript 7 has no compiler API yet, so swc reads the .ts files.
    parser: "swc",
  },
};
