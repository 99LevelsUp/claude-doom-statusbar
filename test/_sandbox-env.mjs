// The environment that points every temp and runtime path of the bar at one test directory:
// the temp directory (Windows, and Node's os.tmpdir() everywhere) and the bar's runtime
// directory (Linux and macOS), so a test never touches the live bar's files. The runtime directory
// is set under both its names, so neither a new nor an old name inherited from the developer's
// environment can point a test elsewhere.
export const sandboxEnv = (dir) => ({ TEMP: dir, TMP: dir, TMPDIR: dir, GAMEBAR_RUNTIME_DIR: dir, DOOMBAR_RUNTIME_DIR: dir });
