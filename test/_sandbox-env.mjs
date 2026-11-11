// The environment that points every temp and runtime path of the bar at one test directory:
// the temp directory (Windows, and Node's os.tmpdir() everywhere) and the bar's runtime
// directory (Linux and macOS), so a test never touches the live bar's files.
export const sandboxEnv = (dir) => ({ TEMP: dir, TMP: dir, TMPDIR: dir, DOOMBAR_RUNTIME_DIR: dir });
