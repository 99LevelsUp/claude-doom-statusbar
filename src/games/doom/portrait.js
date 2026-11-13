// The DOOM mugshot sprite for a reaction (src/metrics/reaction.js): the face the status bar
// shows for what just happened, or an idle glance around the room.

const IDLE_CYCLE = 2; // seconds per idle glance

// Deterministic idle frame (0..2) for a clock bucket.
function _pick(bucket) {
  let x = Math.imul(bucket, 0x9e3779b1) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x85ebca77) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  return x % 3;
}

const EXPRESSION_SPRITES = {
  ouch: (hp) => `STFOUCH${hp}`,
  kill: (hp) => `STFKILL${hp}`,
  evl: (hp) => `STFEVL${hp}`,
  tl: (hp) => `STFTL${hp}0`,
  tr: (hp) => `STFTR${hp}0`,
};

// The sprite name for `reaction` at `now` seconds. A flash the face has no sprite for holds the
// middle idle frame. Without a clock (`now` undefined) the idle face holds that frame too, so a
// preview or a test draws the same face every time.
export function portrait(reaction, now) {
  const { flash, hp } = reaction;
  if (flash === "dead") return "STFDEAD0";
  if (flash === "god") return "STFGOD0";
  if (flash) {
    const sprite = Object.hasOwn(EXPRESSION_SPRITES, flash) ? EXPRESSION_SPRITES[flash] : null;
    return sprite ? sprite(hp) : `STFST${hp}1`;
  }
  if (now === undefined) return `STFST${hp}1`;
  return `STFST${hp}${_pick(Math.floor(now / IDLE_CYCLE))}`;
}
