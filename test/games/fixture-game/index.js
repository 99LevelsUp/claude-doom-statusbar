// A tiny game for the registry test (test only, never shipped): a layout and one preset, and the
// registry entry that describes them. Nothing outside this folder knows about it; the test adds
// the entry to the registry's list.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureLayout } from "./layout.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_GAME = {
  name: "fixture",
  about: "a test-only game",
  aliases: ["fixture-old"],
  layoutKey: "fixture-strip",
  layout: fixtureLayout,
  presets: { fixture: path.join(HERE, "presets", "fixture.toml") },
  defaultPreset: "fixture",
};
