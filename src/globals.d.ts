// The handle for tinkering in the console and for tests: only there with ?debug in the address (see flow.ts).
interface Window {
  derby?: import('./flow.ts').DerbyDebug;
}
// true in the zirbel build only (tools/build.ts --zirbel): the online mode looks for a hub there.
declare const __ZIRBEL__: boolean;
