import { Runtime } from "foldkit";

import { view } from "../features/page.js";
import { init } from "./page/init.js";
import { Flags, Model } from "./page/model.js";
import { update } from "./page/update.js";

import "./page.css";

Runtime.hydrate(
  Runtime.makeApplication({
    Flags,
    Model,
    container: document.querySelector('[data-foldkit-app="app"]'),
    devTools: false,
    init,
    update,
    view,
  }),
);
