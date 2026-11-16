#!/usr/bin/env node
// The skin loader: a TOML skin becomes a tree of elements checked against their descriptors and the
// metric catalogue. A part that no longer holds is skipped or ignored with one warning and the rest
// loads; a file that cannot be read or parsed gives way to the default skin the caller names; a
// rewritten file is loaded again.

import { mkdtempSync, rmSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../_sandbox-env.mjs";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };

const SB = mkdtempSync(path.join(os.tmpdir(), "gamebar-skin-load-"));
Object.assign(process.env, { ...sandboxEnv(SB) });

const { loadSkin, buildSkin } = await import("../../src/kit/skin/load.js");
const { CONTAINERS, FRAMES, VISUALS } = await import("../../src/kit/elements/index.js");

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "skins");
const fixture = (name) => path.join(FIX, name);
const ids = (node) => node.children.map((c) => c.id);
const find = (node, id) => (node.id === id ? node : node.children.map((c) => find(c, id)).find(Boolean) || null);
// Warnings as "cause element subject", the form the expectations are written in.
const brief = (ws) => ws.map((w) => [w.cause, w.element ?? "-", w.subject ?? "-"].join(" "));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameWarnings = (got, want, m) => {
  const b = brief(got);
  ok(same(b, want), `${m}${same(b, want) ? "" : `\n         got  ${JSON.stringify(b)}\n         want ${JSON.stringify(want)}`}`);
};

try {
  console.log("a skin with nothing wrong in it");
  {
    const { skin, warnings } = loadSkin(fixture("full.toml"));
    sameWarnings(warnings, [], "loads with no warnings");
    ok(skin.file === fixture("full.toml") && skin.name === "full" && skin.version === 1, "keeps its file, name and version");
    ok(same(skin.games, ["doom", "minecraft"]) && skin.smaller === "small", "keeps the games it uses and its smaller skin");
    const root = skin.root;
    ok(root.id === "bar" && root.kind === "row" && root.container && root.descriptor === CONTAINERS.row, "the root is the row it names");
    ok(root.params.align === "center" && root.params.separator === "│" && root.params.shrink === "lockstep", "the root's parameters are validated, defaults filled in");
    ok(same(ids(root), ["model", "mugshot", "hotbar"]) && same(ids(find(root, "model")), ["model-name", "context"]), "children follow the order the skin lists them in");
    const model = find(root, "model");
    ok(model.frame && model.frame.kind === "box" && model.frame.descriptor === FRAMES.box, "a container wears the frame its table names");
    ok(model.frame.params.title === "MODEL" && model.frame.params.padding === 1, "the frame's parameters are validated, defaults filled in");
    ok(model.priority === 3 && find(root, "context").priority === 1, "a numeric priority is kept");
    const mug = find(root, "mugshot");
    ok(mug.priority === "keep" && root.priority === null, "\"keep\" is kept as written; no priority is null");
    ok(!mug.container && mug.kind === "animation" && mug.descriptor === VISUALS.animation && mug.metric === "health.headroom", "a metric element names its visual and its metric");
    ok(mug.script === "doom:scripts/mugshot.js" && mug.params.script === "doom:scripts/mugshot.js", "a script the visual declares itself reaches its parameters too");
    ok(mug.params.frames === "doom:images/mugshot" && mug.params.default_frame === "doom:images/mugshot/STFST01.png", "asset references stay as written");
    const name = find(root, "model-name");
    ok(name.script === "doom:scripts/blink.js" && !("script" in name.params) && name.params.width === 20, "a script on a visual that does not declare one stays on the element only");
    ok(same(find(root, "context").params.color, [[50, "#00ff00"], [80, "#ff0000"]]), "a gradient of stops is kept");
    const hotbar = find(root, "hotbar");
    ok(hotbar.frame.kind === "grid" && hotbar.script === "minecraft:scripts/hotbar.js", "a grid-framed row keeps its script");
    ok(find(root, "files").metric === "git.status" && find(root, "files").children.length === 0, "a metric element has no children");
    ok(Object.isFrozen(root) && Object.isFrozen(root.children) && Object.isFrozen(root.params) && Object.isFrozen(model.frame), "the loaded tree is frozen, so no render can change the cached copy");
  }

  console.log("a part that no longer holds is skipped, the rest loads");
  {
    const { skin, warnings } = loadSkin(fixture("unknown-metric.toml"));
    sameWarnings(warnings, ["unknown-metric gone removed.metric"], "a metric the catalogue lacks: one warning");
    ok(/gone/.test(warnings[0].message) && /removed\.metric/.test(warnings[0].message) && /unknown-metric\.toml/.test(warnings[0].message),
      "the warning names the skin, the element and the metric");
    ok(same(ids(skin.root), ["name", "context"]), "every other element loads");
  }
  {
    const { skin, warnings } = loadSkin(fixture("missing-child.toml"));
    sameWarnings(warnings, ["missing-child bar nowhere"], "a missing child id: one warning");
    ok(same(ids(skin.root), ["name"]), "the container loads without it");
  }
  {
    const { skin, warnings } = loadSkin(fixture("unknown-root-param.toml"));
    sameWarnings(warnings, ["unknown-param bar glow"], "an unknown parameter on the root: one warning");
    ok(/glow/.test(warnings[0].message), "the warning names the parameter");
    ok(!("glow" in skin.root.params) && same(ids(skin.root), ["name", "context"]), "the parameter is ignored and the whole tree loads");
  }
  {
    const { skin, warnings } = loadSkin(fixture("repeated-child.toml"));
    sameWarnings(warnings, ["duplicate-child bar name", "duplicate-child inner bar"], "a repeated child and a cycle: one warning each");
    ok(same(ids(skin.root), ["name", "inner"]) && same(ids(find(skin.root, "inner")), ["context"]), "the second reference is skipped, the first stays");
  }
  {
    const { skin, warnings } = loadSkin(fixture("skipped-parts.toml"));
    sameWarnings(warnings, [
      "unknown-key - colour",
      "invalid-key - games",
      "unknown-param bar metric",
      "invalid-param bar shrink",
      "unknown-param name children",
      "type-mismatch wrong-type model.name",
      "no-kind no-kind -",
      "unknown-kind strange hologram",
      "invalid-param boxed priority",
      "unknown-frame boxed cloud",
      "unknown-frame gridded grid",
      "unknown-param framed-text frame",
      "invalid-param scripted script",
      "invalid-param lister children",
      "invalid-param string-framed frame",
      "unknown-frame kindless-frame -",
      "invalid-param padded frame.padding",
    ], "each other kind of broken part: one warning each, in tree order");
    const root = skin.root;
    ok(same(ids(root), ["name", "boxed", "gridded", "framed-text", "scripted", "lister", "string-framed", "kindless-frame", "padded", "numbered"]),
      "skipped elements leave their siblings in place");
    ok(same(skin.games, []), "an invalid setting keeps its default");
    ok(find(root, "scripted").script === null && find(root, "lister").children.length === 0, "an invalid script or children list is dropped");
    ok(find(root, "string-framed").frame === null && find(root, "kindless-frame").frame === null, "a frame that is not a table with a kind is dropped");
    ok(find(root, "padded").frame.params.padding === 1, "an invalid frame parameter keeps its default, the frame stays");
    ok(root.metric === null && root.params.shrink === "lockstep", "an invalid parameter falls back to its default; a container binds no metric");
    ok(find(root, "name").children.length === 0, "children listed by a metric element are ignored");
    ok(find(root, "boxed").frame === null && find(root, "boxed").priority === null, "an unknown frame and an invalid priority are dropped");
    ok(find(root, "gridded").frame === null && find(root, "framed-text").frame === null, "a frame that cannot frame the element is dropped");
    ok(new Set(warnings.map((w) => w.key)).size === warnings.length, "every warning has its own key");
  }

  console.log("a skin that cannot be drawn gives way to the default skin");
  {
    const { skin, warnings } = loadSkin(fixture("broken.toml"), { fallback: fixture("full.toml") });
    sameWarnings(warnings, ["parse-error - -"], "a skin that does not parse: one warning");
    ok(/broken\.toml/.test(warnings[0].message), "the warning names the file");
    ok(skin && skin.file === fixture("full.toml") && skin.root.id === "bar", "the default skin loads in its place");
  }
  {
    const { skin, warnings } = loadSkin(fixture("broken.toml"));
    ok(skin === null && warnings.length === 1, "without a default skin nothing loads, and the warning still says why");
  }
  {
    const { skin, warnings } = loadSkin(fixture("absent.toml"), { fallback: fixture("full.toml") });
    sameWarnings(warnings, ["unreadable - -"], "a file that is not there: one warning");
    ok(skin && skin.file === fixture("full.toml"), "the default skin loads in its place");
  }
  {
    const { skin, warnings } = loadSkin(fixture("no-root.toml"), { fallback: fixture("full.toml") });
    sameWarnings(warnings, ["unknown-kind bar hologram", "no-root - bar"], "a root that is skipped: why, and that nothing is left");
    ok(skin && skin.file === fixture("full.toml"), "the default skin loads in its place");
  }
  {
    const { skin, warnings } = loadSkin(fixture("broken.toml"), { fallback: fixture("missing-child.toml") });
    sameWarnings(warnings, ["parse-error - -", "missing-child bar nowhere"], "the default skin's own warnings follow the cause");
    ok(skin.file === fixture("missing-child.toml"), "and it loads");
  }
  {
    const { skin, warnings } = loadSkin(fixture("broken.toml"), { fallback: fixture("no-root.toml") });
    ok(skin === null && brief(warnings)[0] === "parse-error - -" && warnings.length === 3, "a default skin that fails too: nothing loads, every cause is reported");
  }

  console.log("a skin built from parsed data names what it lacks");
  {
    const cases = [
      [{ element: {} }, ["no-root - -"], "no root named"],
      [{ root: 5, element: {} }, ["no-root - -"], "a root that is not an id"],
      [{ root: "bar", element: { other: { kind: "row" } } }, ["no-root - bar"], "a root id no element has"],
      [{ root: "bar", element: 3 }, ["invalid-key - element", "no-root - bar"], "elements that are not a table"],
      [null, ["parse-error - -"], "data that is not a table"],
    ];
    for (const [data, want, m] of cases) {
      const { skin, warnings } = buildSkin(data, "x.toml");
      sameWarnings(warnings, want, `${m}: nothing to draw`);
      ok(skin === null, `${m}: no skin`);
    }
  }

  console.log("a user skin is loaded again when its file changes");
  {
    const file = path.join(SB, "mine.toml");
    copyFileSync(fixture("unknown-root-param.toml"), file);
    const first = loadSkin(file);
    ok(brief(first.warnings)[0] === "unknown-param bar glow", "the first load");
    ok(loadSkin(file).skin === first.skin, "an unchanged file comes from the cache");
    const again = loadSkin(file);
    again.warnings.push("x");
    ok(loadSkin(file).warnings.length === 1, "a caller changing the returned warnings does not change the cache");
    writeFileSync(file, readFileSync(fixture("missing-child.toml"), "utf8"));
    const next = loadSkin(file);
    sameWarnings(next.warnings, ["missing-child bar nowhere"], "the rewritten file's warnings");
    ok(next.skin !== first.skin && same(ids(next.skin.root), ["name"]), "the next load returns the new tree");
  }

  console.log("when_absent: what a metric element does while its metric is absent");
  {
    const { skin, warnings } = buildSkin({ version: 1, root: "bar", element: {
      bar: { kind: "row", children: ["xp", "hearts", "name", "odd", "free"], when_absent: "full" },
      xp: { kind: "progress", metric: "ratelimit.7d", when_absent: "empty" },
      hearts: { kind: "icon-row", metric: "ratelimit.5h", when_absent: "full" },
      name: { kind: "text", metric: "model.name" },
      odd: { kind: "text", metric: "model.name", when_absent: "always" },
      free: { kind: "text", when_absent: "hide" },
    } }, "absent.toml");
    const at = (id) => find(skin.root, id);
    ok(at("xp").whenAbsent === "empty" && at("hearts").whenAbsent === "full" && at("free").whenAbsent === "hide",
      "a metric element keeps the when_absent it gives: hide, empty or full");
    ok(at("name").whenAbsent === "hide" && at("odd").whenAbsent === "hide" && skin.root.whenAbsent === "hide",
      "without it, with a value it does not allow, and on a container it is hide");
    ok(!("when_absent" in at("xp").params), "it is a shared setting, not a parameter of the visual");
    sameWarnings(warnings, ["unknown-param bar when_absent", "invalid-param odd when_absent"],
      "a container's when_absent is unknown, a value other than hide, empty or full is invalid");
    ok((warnings.find((w) => w.element === "odd") || {}).message?.includes('"hide", "empty" or "full"'), "the warning names the values it allows");
  }
} finally {
  rmSync(SB, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
