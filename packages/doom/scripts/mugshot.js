// The DOOM mugshot's frame: the face the bar shows for what just happened in the session, or an idle
// glance around the room. A selection script for the animation element: the bar calls
// render(input) each render and draws the frame it names from the mugshot images.
//
// input.reaction is the session's game-neutral reaction: `flash` the expression to show now (dead,
// god, ouch, kill, evl, tl, tr, or null when calm) and `hp` the health row, 0 (healthy) to 4.
// input.now is the time in seconds.

var IDLE_CYCLE = 2; // seconds per idle glance

// The idle frame (0 to 2) for a clock bucket: the same bucket always glances the same way.
function idleFrame(bucket) {
  var x = Math.imul(bucket, 0x9e3779b1) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x85ebca77) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  return x % 3;
}

var EXPRESSIONS = {
  ouch: function (hp) { return "STFOUCH" + hp; },
  kill: function (hp) { return "STFKILL" + hp; },
  evl: function (hp) { return "STFEVL" + hp; },
  tl: function (hp) { return "STFTL" + hp + "0"; },
  tr: function (hp) { return "STFTR" + hp + "0"; },
};

// The frame for `reaction` at `now` seconds. An expression the face has no frame for holds the
// middle idle frame, and so does the idle face without a clock.
function render(input) {
  var reaction = input.reaction || {};
  var flash = reaction.flash;
  var hp = reaction.hp;
  if (flash === "dead") return { frame: "STFDEAD0" };
  if (flash === "god") return { frame: "STFGOD0" };
  if (flash) {
    var face = Object.prototype.hasOwnProperty.call(EXPRESSIONS, flash) ? EXPRESSIONS[flash] : null;
    return { frame: face ? face(hp) : "STFST" + hp + "1" };
  }
  if (typeof input.now !== "number") return { frame: "STFST" + hp + "1" };
  return { frame: "STFST" + hp + idleFrame(Math.floor(input.now / IDLE_CYCLE)) };
}
