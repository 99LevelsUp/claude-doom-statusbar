// The fixture game's layout: one plain line that shows what it was given, so the registry test can
// see that its own layout drew its own preset from the render context.
export function fixtureLayout(cfg, target, ctx) {
  const { title = "?" } = cfg.fixture || {};
  return [`${title} | width ${target} | model ${ctx.values["model.name"]} | hp ${ctx.reaction.hp}`];
}
