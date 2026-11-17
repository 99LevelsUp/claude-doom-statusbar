// The asset store (src/platform/assets.js) as skins use it: the games whose assets a skin and the
// skins of its smaller chain use, the store folders of those games, and installing them now (the
// `install` and `skin` commands).

import { findGame } from "./games/index.js";
import { findSkin } from "./skin-select.js";
import { loadSkin } from "./kit/skin/load.js";
import { pinOf, checkoutRoot, installAssets, parseAssetRef } from "./platform/assets.js";

// Loaded skins are frozen and shared by every render, so their games are worked out once.
const gamesBySkin = new WeakMap();

// The games a skin's assets come from: those its `games` list names and those its references name
// (scripts and asset parameters of its elements and frames). Names that are not games stay in the
// list, so a lookup can say so.
export function skinGames(skin) {
  const cached = skin ? gamesBySkin.get(skin) : undefined;
  if (cached) return [...cached];
  const names = new Set((skin && skin.games) || []);
  const take = (ref) => {
    if (typeof ref !== "string" || ref === "") return;
    const r = parseAssetRef(ref);
    if (r.kind === "game") names.add(r.game);
    else if (r.kind === "package") names.add(r.name.startsWith("@") ? r.name : `npm:${r.name}`);
  };
  const assetParams = (descriptor, params) => {
    const schema = (descriptor && descriptor.params) || {};
    for (const [k, v] of Object.entries(params || {})) if (schema[k] && schema[k].type === "asset") take(v);
  };
  const walk = (node) => {
    if (!node) return;
    take(node.script);
    assetParams(node.descriptor, node.params);
    if (node.frame) assetParams(node.frame.descriptor, node.frame.params);
    for (const c of node.children || []) walk(c);
  };
  walk(skin && skin.root);
  const list = [...names];
  if (skin && typeof skin === "object") gamesBySkin.set(skin, list);
  return [...list];
}

// A loaded skin and the skins of its smaller chain, loaded, in order. A name that draws nothing
// ends the chain, as does a skin met twice.
export function skinChain(skin, env = process.env) {
  const chain = [];
  const seen = new Set();
  let s = skin;
  while (s && !seen.has(s.file)) {
    seen.add(s.file);
    chain.push(s);
    const next = s.smaller ? findSkin(s.smaller, env) : null;
    s = next && next.file ? loadSkin(next.file).skin : null;
  }
  return chain;
}

export const chainGames = (skin, env = process.env) => [...new Set(skinChain(skin, env).flatMap(skinGames))];

function loadNamed(name, env) {
  const s = findSkin(name, env);
  return s && s.file ? loadSkin(s.file).skin : null;
}

// The store folders (<game>@<version>) the chain of the skin called `name` uses.
export function skinPackages(name, env = process.env) {
  const skin = loadNamed(name, env);
  if (!skin) return [];
  return [...new Set(chainGames(skin, env).map((g) => pinOf(findGame(g))).filter(Boolean).map((p) => p.key))].sort();
}

// Installs, now, every pinned package the chain of the skin called `name` uses and the store or
// the checkout does not have yet (`install` and the `skin` command). Returns a line per package.
export async function installSkinAssets(name, { env = process.env } = {}) {
  const skin = loadNamed(name, env);
  if (!skin) return [];
  const lines = [];
  for (const g of chainGames(skin, env)) {
    const game = findGame(g);
    const pin = pinOf(game);
    if (!pin || checkoutRoot(game)) continue;
    const r = await installAssets(game, { env, ignoreRetry: true });
    const id = `${pin.package}@${pin.version}`;
    if (r.status === "installed") lines.push(`installed the assets of ${game.name} (${id})`);
    else if (r.status === "locked") lines.push(`the assets of ${game.name} (${id}) are being installed in the background`);
    else if (r.status === "failed") lines.push(`could not install the assets of ${game.name} (${id}): ${r.message}; the bar tries again later`);
  }
  return lines;
}
