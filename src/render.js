// Render one session's bar with the skin's scripts run: the entry the render daemon and the tests
// use. The rendering itself is src/render-core.js; see renderSessionWith there for the options.

import { runScripts } from "./kit/skin/scripts.js";
import { renderSessionWith } from "./render-core.js";

export const renderSession = (options) => renderSessionWith(runScripts, options);
