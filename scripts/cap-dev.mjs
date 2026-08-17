// Android debug session: build, sync and open Android Studio with WebView
// debugging switched on, so the running app shows up in chrome://inspect.
//
// This exists as a script rather than an inline `CAP_DEBUG=1 ...` in
// package.json because that syntax is a POSIX shell feature — it fails on
// Windows cmd/PowerShell, which is where this project is developed. The usual
// fix is the `cross-env` package; a dozen lines of Node avoids the dependency.
//
// The APK this produces is for a cable-attached debug session ONLY. WebView
// debugging lets anyone with physical access and a USB cable read the
// signed-in user's Supabase session straight out of the app. Never ship it —
// use `npm run cap:android` for anything that reaches a real user.

import { spawnSync } from "node:child_process";

const env = { ...process.env, CAP_DEBUG: "1" };

const steps = [
  ["vite", ["build"]],
  ["cap", ["sync", "android"]],
  ["cap", ["open", "android"]],
];

for (const [cmd, args] of steps) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  // shell:true so Windows resolves the .cmd shims npm puts in node_modules/.bin.
  const r = spawnSync(cmd, args, { stdio: "inherit", env, shell: true });
  if (r.status !== 0) {
    console.error(`\n${cmd} ${args.join(" ")} failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
}

console.log(
  "\nAndroid Studio is opening. Run the app, then open chrome://inspect#devices" +
  "\non this machine and click 'inspect' under Bastion to get the console.",
);
