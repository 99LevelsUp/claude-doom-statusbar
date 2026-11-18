// The Minecraft hotbar's highlighted cell: the slot of what just happened in the session (a tool
// failed, a file was written, a task finished) for a few seconds, otherwise a slot that wanders every
// few seconds like a player scrolling. A script for a container framed as a grid: the bar calls
// render(input) each render and draws the cell it selects in its own lines.
//
// input.children are the slots that fit the terminal, in order, each with its id in the skin; the
// highlight picks only among them. input.reaction is the session's game-neutral reaction: `expr` the
// last expression and `exprAge` its age in seconds (null when there is none). input.now is the time
// in seconds. input.state is what this script returned as `state` the last time it ran for the
// hotbar in this session.
//
// It returns the selected slot and, as its state, which slot that is and when the highlight last
// moved: { cell, id, movedAt }. The choice itself depends only on the time and the reaction, so every
// render in the same second agrees, and a test can pin it from input.now.

var IDLE_SWITCH = 7; // seconds between idle slot changes
var REACT_HOLD = 6;  // seconds the slot stays on what just happened

// The slot each expression jumps to, by its id in the bundled Minecraft skin.
var REACT = { ouch: "slot-errors", kill: "slot-added", evl: "slot-tasks" };

// Deterministic "random" pick, so every render in the same second agrees.
function pick(seed, n) {
  var x = Math.imul(seed, 0x9e3779b1) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x85ebca77) >>> 0;
  return ((x ^ (x >>> 13)) >>> 0) % n;
}

// The slot to select: the one of what just happened while it is recent, else the idle pick of the
// current interval.
function choose(children, reaction, now) {
  var expr = reaction.expr;
  var age = reaction.exprAge;
  if (expr && typeof age === "number" && age < REACT_HOLD && Object.prototype.hasOwnProperty.call(REACT, expr)) {
    for (var i = 0; i < children.length; i++) if (children[i].id === REACT[expr]) return i;
  }
  return pick(Math.floor(now / IDLE_SWITCH), children.length);
}

function render(input) {
  var children = input.children || [];
  if (!children.length) return {};
  var now = typeof input.now === "number" ? input.now : 0;
  var selected = choose(children, input.reaction || {}, now);
  var id = children[selected].id;
  var last = input.state || {};
  var movedAt = last.id === id && typeof last.movedAt === "number" ? last.movedAt : now;
  return { selected: selected, state: { cell: selected, id: id, movedAt: movedAt } };
}
