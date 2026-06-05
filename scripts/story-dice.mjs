const MODULE_ID = "story-dice";

const SETTINGS = {
  FUDGE_QUEUE: "fudgeQueue",
  FUDGE_D10_VALUE: "fudgeD10Value",
  FUDGE_D6_VALUE: "fudgeD6Value",
  FUDGE_ROLL_GROUP: "fudgeRollGroup",
  FUDGE_HISTORY: "fudgeHistory",
};

const ROLL_GROUPS = {
  D10: "d10",
  D6: "d6",
  ALL: "all",
};

const SOCKET = `module.${MODULE_ID}`;
const MAX_HISTORY = 30;

const localConsumed = new Set();

function localize(key) {
  return game.i18n.localize(key);
}

function format(key, data) {
  return game.i18n.format(key, data);
}

function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

async function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}

// ---------------------------------------------------------------------------
// Settings registration
// ---------------------------------------------------------------------------

Hooks.once("init", () => {
  injectSceneControl();

  game.settings.register(MODULE_ID, SETTINGS.FUDGE_QUEUE, {
    scope: "world",
    config: false,
    type: Array,
    default: [],
  });

  game.settings.register(MODULE_ID, SETTINGS.FUDGE_D10_VALUE, {
    scope: "world",
    config: false,
    type: Number,
    default: 1,
    range: { min: 1, max: 10 },
  });

  game.settings.register(MODULE_ID, SETTINGS.FUDGE_D6_VALUE, {
    scope: "world",
    config: false,
    type: Number,
    default: 1,
    range: { min: 1, max: 6 },
  });

  game.settings.register(MODULE_ID, SETTINGS.FUDGE_ROLL_GROUP, {
    scope: "world",
    config: false,
    type: String,
    default: ROLL_GROUPS.ALL,
    choices: {
      [ROLL_GROUPS.D10]: localize("STORYDICE.RollGroup.D10"),
      [ROLL_GROUPS.D6]: localize("STORYDICE.RollGroup.D6"),
      [ROLL_GROUPS.ALL]: localize("STORYDICE.RollGroup.All"),
    },
  });

  game.settings.register(MODULE_ID, SETTINGS.FUDGE_HISTORY, {
    scope: "world",
    config: false,
    type: Array,
    default: [],
  });
});

// ---------------------------------------------------------------------------
// Ready: register libWrapper shim, socket listener & expose API
// ---------------------------------------------------------------------------

Hooks.once("ready", () => {
  libWrapper.register(MODULE_ID, "Roll.prototype.evaluate", onRollEvaluate, "WRAPPER");
  exposeAPI();
  injectActorSheetButton();

  game.socket.on(SOCKET, async (data) => {
    if (!game.user.isGM) return;
    if (data.action === "fudgeConsumed") {
      await removeQueueEntry(data.entryId);
      await recordHistory(
        data.userId,
        data.formula,
        data.realTotal,
        data.fudgeTotal,
        data.realFaces,
        data.fudgeFaces
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Roll evaluation interceptor
// ---------------------------------------------------------------------------

async function onRollEvaluate(wrapped, options = {}) {
  const result = await wrapped(options);

  if (options.minimize || options.maximize) return result;

  const userId = game.user.id;
  if (localConsumed.has(userId)) return result;

  const entry = findQueueEntry(userId);
  if (!entry) return result;

  const formula = this.formula;

  const isD10 = /^1d10$/i.test(formula);
  const isD6 = /^\d+d6$/i.test(formula);

  if (entry.rollGroup === ROLL_GROUPS.D10 && !isD10) return result;
  if (entry.rollGroup === ROLL_GROUPS.D6 && !isD6) return result;
  if (entry.rollGroup === ROLL_GROUPS.ALL && !isD10 && !isD6) return result;

  const diceTerm = findDiceTerm(this);
  if (!diceTerm) return result;

  const fudgeValue = isD10 ? entry.d10Value : entry.d6Value;
  const dieCount = diceTerm.number;
  const realTotal = this._total;
  const realFaces = diceTerm.results.map((r) => r.result);
  const realFacesStr = realFaces.join(",");
  const fudgeFacesStr = Array(dieCount).fill(fudgeValue).join(",");
  const fudgeTotal = fudgeValue * dieCount;

  diceTerm.results.forEach((r) => {
    r.result = fudgeValue;
    r.active = true;
  });
  this._total = fudgeTotal;

  localConsumed.add(userId);

  if (game.user.isGM) {
    await removeQueueEntry(entry.id);
    await recordHistory(userId, formula, realTotal, fudgeTotal, realFacesStr, fudgeFacesStr);
  } else {
    game.socket.emit(SOCKET, {
      action: "fudgeConsumed",
      entryId: entry.id,
      userId,
      formula,
      realTotal,
      fudgeTotal,
      realFaces: realFacesStr,
      fudgeFaces: fudgeFacesStr,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Dice term detection
// ---------------------------------------------------------------------------

function findDiceTerm(roll) {
  return roll.terms.find(
    (t) => typeof t.number === "number" && typeof t.faces === "number" && Array.isArray(t.results)
  );
}

// ---------------------------------------------------------------------------
// Queue helpers
// ---------------------------------------------------------------------------

function findQueueEntry(userId) {
  if (!userId) return null;
  const queue = setting(SETTINGS.FUDGE_QUEUE) || [];
  return queue.find((e) => e.userId === userId) || null;
}

async function addQueueEntry(userId, d10Value, d6Value, rollGroup) {
  const queue = foundry.utils.duplicate(setting(SETTINGS.FUDGE_QUEUE)) || [];
  const existingIdx = queue.findIndex((e) => e.userId === userId);
  const entry = {
    id: foundry.utils.randomID(),
    userId,
    d10Value: Math.clamped(d10Value ?? 1, 1, 10),
    d6Value: Math.clamped(d6Value ?? 1, 1, 6),
    rollGroup: rollGroup ?? ROLL_GROUPS.ALL,
  };
  if (existingIdx >= 0) {
    queue[existingIdx] = entry;
  } else {
    queue.push(entry);
  }
  await setSetting(SETTINGS.FUDGE_QUEUE, queue);
}

async function removeQueueEntry(entryId) {
  const queue = foundry.utils.duplicate(setting(SETTINGS.FUDGE_QUEUE)) || [];
  const idx = queue.findIndex((e) => e.id === entryId);
  if (idx >= 0) {
    queue.splice(idx, 1);
    await setSetting(SETTINGS.FUDGE_QUEUE, queue);
  }
}

async function clearQueue() {
  await setSetting(SETTINGS.FUDGE_QUEUE, []);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

async function recordHistory(userId, formula, realTotal, fudgeTotal, realFaces, fudgeFaces) {
  const user = game.users.get(userId);
  const history = foundry.utils.duplicate(setting(SETTINGS.FUDGE_HISTORY)) || [];
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;

  history.unshift({
    time: timeStr,
    playerId: userId,
    playerName: user ? user.name : userId,
    formula,
    realTotal,
    fudgeTotal,
    realFaces,
    fudgeFaces,
  });

  while (history.length > MAX_HISTORY) {
    history.pop();
  }

  await setSetting(SETTINGS.FUDGE_HISTORY, history);
}

// ---------------------------------------------------------------------------
// GM Panel — FormApplication
// ---------------------------------------------------------------------------

class StoryDicePanel extends FormApplication {
  constructor(object = {}, options = {}) {
    super(object, options);
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "story-dice-panel",
      title: localize("STORYDICE.Panel.Title"),
      template: `modules/${MODULE_ID}/templates/gm-panel.hbs`,
      width: 450,
      height: "auto",
      resizable: true,
      closeOnSubmit: false,
      submitOnChange: false,
      classes: ["story-dice-panel"],
    });
  }

  getData(_options = {}) {
    const queue = setting(SETTINGS.FUDGE_QUEUE) || [];
    const d10Value = setting(SETTINGS.FUDGE_D10_VALUE);
    const d6Value = setting(SETTINGS.FUDGE_D6_VALUE);
    const rollGroup = setting(SETTINGS.FUDGE_ROLL_GROUP);
    const history = setting(SETTINGS.FUDGE_HISTORY) || [];

    const players = game.users
      .filter((u) => u.active)
      .map((u) => ({
        id: u.id,
        name: u.isGM ? `${u.name} (GM)` : u.name,
        isGM: u.isGM,
      }));

    const queueEntries = queue.map((entry) => {
      const user = game.users.get(entry.userId);
      let valueLabel;
      let groupLabel;
      if (entry.rollGroup === ROLL_GROUPS.D10) {
        valueLabel = `d10=${entry.d10Value}`;
        groupLabel = localize("STORYDICE.RollGroup.D10");
      } else if (entry.rollGroup === ROLL_GROUPS.D6) {
        valueLabel = `d6=${entry.d6Value}`;
        groupLabel = localize("STORYDICE.RollGroup.D6");
      } else {
        valueLabel = `d10=${entry.d10Value} / d6=${entry.d6Value}`;
        groupLabel = localize("STORYDICE.RollGroup.All");
      }
      return {
        id: entry.id,
        userId: entry.userId,
        playerName: user ? user.name : entry.userId,
        valueLabel,
        groupLabel,
      };
    });

    return {
      queueEntries,
      queueCount: queueEntries.length,
      d10Value,
      d6Value,
      rollGroup,
      players,
      history: history.slice(0, MAX_HISTORY),
      rollGroups: [
        { value: ROLL_GROUPS.D10, label: localize("STORYDICE.RollGroup.D10"), selected: rollGroup === ROLL_GROUPS.D10 },
        { value: ROLL_GROUPS.D6, label: localize("STORYDICE.RollGroup.D6"), selected: rollGroup === ROLL_GROUPS.D6 },
        { value: ROLL_GROUPS.ALL, label: localize("STORYDICE.RollGroup.All"), selected: rollGroup === ROLL_GROUPS.ALL },
      ],
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("#story-dice-add").click(this._onAdd.bind(this));
    html.find("#story-dice-clear-queue").click(this._onClearQueue.bind(this));
    html.find("#story-dice-clear-history").click(this._onClearHistory.bind(this));
    html.find("#story-dice-roll-group").on("change", this._onRollGroupChange.bind(this));
    html.find(".story-dice-remove-entry").click(this._onRemoveEntry.bind(this));
    this._updateValueVisibility(html);
  }

  _onRollGroupChange(event) {
    const group = event.currentTarget.value;
    this._setValueVisibility(group);
  }

  _updateValueVisibility(html) {
    const group = html.find("#story-dice-roll-group").val();
    this._setValueVisibility(group);
  }

  _setValueVisibility(group) {
    const d10Group = this.element.find("#story-dice-d10-group");
    const d6Group = this.element.find("#story-dice-d6-group");

    if (group === ROLL_GROUPS.D10) {
      d10Group.show();
      d6Group.hide();
    } else if (group === ROLL_GROUPS.D6) {
      d10Group.hide();
      d6Group.show();
    } else {
      d10Group.show();
      d6Group.show();
    }
  }

  async _onAdd(event) {
    event.preventDefault();
    const fd = new FormDataExtended(this.element.find("form")[0]);
    const data = fd.object;

    const targetUserId = data.targetUserId;
    if (!targetUserId) {
      ui.notifications.warn(localize("STORYDICE.Warn.SelectPlayer"));
      return;
    }

    const d10Value = Math.clamped(parseInt(data.d10Value, 10) || 1, 1, 10);
    const d6Value = Math.clamped(parseInt(data.d6Value, 10) || 1, 1, 6);
    const rollGroup = data.rollGroup || ROLL_GROUPS.ALL;

    await setSetting(SETTINGS.FUDGE_D10_VALUE, d10Value);
    await setSetting(SETTINGS.FUDGE_D6_VALUE, d6Value);
    await setSetting(SETTINGS.FUDGE_ROLL_GROUP, rollGroup);
    await addQueueEntry(targetUserId, d10Value, d6Value, rollGroup);

    this.render();
  }

  async _onRemoveEntry(event) {
    event.preventDefault();
    const entryId = event.currentTarget.closest("[data-entry-id]")?.dataset?.entryId;
    if (!entryId) return;
    await removeQueueEntry(entryId);
    this.render();
  }

  async _onClearQueue(event) {
    event.preventDefault();
    await clearQueue();
    this.render();
  }

  async _onClearHistory(event) {
    event.preventDefault();
    await setSetting(SETTINGS.FUDGE_HISTORY, []);
    this.render();
  }

  async _updateObject(_event, _formData) {
    // Not used — actions are manual via button clicks
  }
}

// ---------------------------------------------------------------------------
// Scene control button (left sidebar)
// ---------------------------------------------------------------------------

function injectSceneControl() {
  Hooks.on("getSceneControlButtons", (controls) => {
    if (!game.user.isGM) return;
    const notesGroup = controls.find((c) => c.name === "notes");
    if (!notesGroup) return;
    notesGroup.tools.push({
      name: MODULE_ID,
      title: localize("STORYDICE.Control.Title"),
      icon: "fas fa-dice-d20",
      onClick: () => {
        if (game.storydice) game.storydice.openPanel();
      },
      button: true,
    });
  });
}

// ---------------------------------------------------------------------------
// Actor sheet header button
// ---------------------------------------------------------------------------

function injectActorSheetButton() {
  Hooks.on("renderActorSheet", (_app, html, _data) => {
    if (!game.user.isGM) return;
    const actor = _app.object;
    if (actor?.type !== "character" && actor?.type !== "mook") return;

    const queueLen = (setting(SETTINGS.FUDGE_QUEUE) || []).length;
    const container = html.find(".window-header .window-title");
    if (!container.length) return;

    const existing = container.parent().find(".story-dice-header-btn");
    if (existing.length) return;

    const cls = queueLen > 0 ? "story-dice-header-btn active" : "story-dice-header-btn";
    const btn = $(
      `<a class="${cls}" title="${localize("STORYDICE.Control.Title")}"><i class="fas fa-dice-d20"></i></a>`
    );
    btn.on("click", () => game.storydice.openPanel());
    btn.css({
      "margin-left": "auto",
      "margin-right": "4px",
      "cursor": "pointer",
      "opacity": queueLen > 0 ? "1" : "0.5",
    });
    container.parent().find(".window-title").after(btn);
  });
}

// ---------------------------------------------------------------------------
// Update panel when settings change
// ---------------------------------------------------------------------------

Hooks.on("updateSetting", (setting) => {
  if (!setting.key.startsWith(`${MODULE_ID}.`)) return;

  if (setting.key === `${MODULE_ID}.${SETTINGS.FUDGE_QUEUE}`) {
    const queue = setting.value || [];
    const stillQueued = queue.some((e) => e.userId === game.user.id);
    if (!stillQueued) localConsumed.delete(game.user.id);
  }

  const panel = Object.values(ui.windows).find(
    (w) => w instanceof StoryDicePanel
  );
  if (panel) panel.render();

  if (game.user.isGM) {
    Object.values(ui.windows).forEach((w) => {
      if (w.constructor.name?.includes("ActorSheet")) w.render();
    });
  }
});

// ---------------------------------------------------------------------------
// Global API
// ---------------------------------------------------------------------------

function exposeAPI() {
  game.storydice = {
    MODULE_ID,
    ROLL_GROUPS,

    openPanel() {
      if (!game.user.isGM) {
        ui.notifications.error(localize("STORYDICE.Error.GMOnly"));
        return;
      }
      new StoryDicePanel().render(true);
    },

    async activateFudge(userId, d10Value, d6Value, rollGroup) {
      if (!game.user.isGM) return;
      await addQueueEntry(
        userId,
        Math.clamped(d10Value ?? 1, 1, 10),
        Math.clamped(d6Value ?? 1, 1, 6),
        rollGroup ?? ROLL_GROUPS.ALL
      );
    },

    async deactivateFudge(userId) {
      if (!game.user.isGM) return;
      if (userId) {
        const queue = setting(SETTINGS.FUDGE_QUEUE) || [];
        const entry = queue.find((e) => e.userId === userId);
        if (entry) await removeQueueEntry(entry.id);
      } else {
        await clearQueue();
      }
    },

    async deactivateAll() {
      if (!game.user.isGM) return;
      await clearQueue();
    },

    isActive(userId) {
      return !!findQueueEntry(userId);
    },

    getQueue() {
      return setting(SETTINGS.FUDGE_QUEUE) || [];
    },

    getStatus() {
      return {
        queue: setting(SETTINGS.FUDGE_QUEUE) || [],
        history: setting(SETTINGS.FUDGE_HISTORY) || [],
      };
    },
  };
}
