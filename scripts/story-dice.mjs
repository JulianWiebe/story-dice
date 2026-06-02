const MODULE_ID = "story-dice";

const SETTINGS = {
  FUDGE_ACTIVE: "fudgeActive",
  FUDGE_TARGET_USER_ID: "fudgeTargetUserId",
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

const MAX_HISTORY = 30;

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

  game.settings.register(MODULE_ID, SETTINGS.FUDGE_ACTIVE, {
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, SETTINGS.FUDGE_TARGET_USER_ID, {
    scope: "world",
    config: false,
    type: String,
    default: "",
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
// Ready: register libWrapper shim & expose API
// ---------------------------------------------------------------------------

Hooks.once("ready", () => {
  libWrapper.register(MODULE_ID, "Roll.prototype.evaluate", onRollEvaluate, "WRAPPER");
  exposeAPI();
  injectActorSheetButton();
});

// ---------------------------------------------------------------------------
// Roll evaluation interceptor
// ---------------------------------------------------------------------------

async function onRollEvaluate(wrapped, options = {}) {
  const result = await wrapped(options);

  if (options.minimize || options.maximize) return result;
  if (!shouldFudge()) return result;

  const fudgeSettings = readFudgeSettings();
  const formula = this.formula;

  const isD10 = /^1d10$/i.test(formula);
  const isD6 = /^\d+d6$/i.test(formula);

  if (fudgeSettings.rollGroup === ROLL_GROUPS.D10 && !isD10) return result;
  if (fudgeSettings.rollGroup === ROLL_GROUPS.D6 && !isD6) return result;
  if (fudgeSettings.rollGroup === ROLL_GROUPS.ALL && !isD10 && !isD6) return result;

  const diceTerm = findDiceTerm(this);
  if (!diceTerm) return result;

  const fudgeValue = isD10 ? fudgeSettings.d10Value : fudgeSettings.d6Value;
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

  await clearFudge();
  await recordHistory(
    fudgeSettings.targetUserId,
    formula,
    realTotal,
    fudgeTotal,
    realFacesStr,
    fudgeFacesStr
  );

  return result;
}

// ---------------------------------------------------------------------------
// Dice term detection — duck-type check works across Foundry versions
// ---------------------------------------------------------------------------

function findDiceTerm(roll) {
  return roll.terms.find(
    (t) => typeof t.number === "number" && typeof t.faces === "number" && Array.isArray(t.results)
  );
}

// ---------------------------------------------------------------------------
// Fudge helpers
// ---------------------------------------------------------------------------

function shouldFudge() {
  if (!setting(SETTINGS.FUDGE_ACTIVE)) return false;
  const targetUserId = setting(SETTINGS.FUDGE_TARGET_USER_ID);
  return targetUserId === game.user.id;
}

function readFudgeSettings() {
  return {
    rollGroup: setting(SETTINGS.FUDGE_ROLL_GROUP),
    d10Value: setting(SETTINGS.FUDGE_D10_VALUE),
    d6Value: setting(SETTINGS.FUDGE_D6_VALUE),
    targetUserId: setting(SETTINGS.FUDGE_TARGET_USER_ID),
  };
}

async function clearFudge() {
  await setSetting(SETTINGS.FUDGE_ACTIVE, false);
  await setSetting(SETTINGS.FUDGE_TARGET_USER_ID, "");
}

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
      width: 420,
      height: "auto",
      resizable: true,
      closeOnSubmit: false,
      submitOnChange: false,
      classes: ["story-dice-panel"],
    });
  }

  getData(_options = {}) {
    const fudgeActive = setting(SETTINGS.FUDGE_ACTIVE);
    const targetUserId = setting(SETTINGS.FUDGE_TARGET_USER_ID);
    const d10Value = setting(SETTINGS.FUDGE_D10_VALUE);
    const d6Value = setting(SETTINGS.FUDGE_D6_VALUE);
    const rollGroup = setting(SETTINGS.FUDGE_ROLL_GROUP);
    const history = setting(SETTINGS.FUDGE_HISTORY) || [];
    const targetUser = game.users.get(targetUserId);

    const players = game.users
      .filter((u) => u.active)
      .map((u) => ({
        id: u.id,
        name: u.isGM ? `${u.name} (GM)` : u.name,
        isGM: u.isGM,
        selected: u.id === targetUserId,
      }));

    let groupLabel;
    let displayValue;
    if (rollGroup === ROLL_GROUPS.D10) {
      groupLabel = localize("STORYDICE.RollGroup.D10");
      displayValue = d10Value;
    } else if (rollGroup === ROLL_GROUPS.D6) {
      groupLabel = localize("STORYDICE.RollGroup.D6");
      displayValue = d6Value;
    } else {
      groupLabel = localize("STORYDICE.RollGroup.All");
      displayValue = d10Value;
    }

    const targetName = targetUser ? targetUser.name : "";
    let statusText;
    if (fudgeActive) {
      statusText = format("STORYDICE.Status.Active", {
        player: targetName,
        value: displayValue,
        group: groupLabel,
      });
    } else {
      statusText = localize("STORYDICE.Status.Idle");
    }

    return {
      fudgeActive,
      targetUserId,
      targetName,
      d10Value,
      d6Value,
      rollGroup,
      players,
      history: history.slice(0, MAX_HISTORY),
      rollGroups: [
        {
          value: ROLL_GROUPS.D10,
          label: localize("STORYDICE.RollGroup.D10"),
          selected: rollGroup === ROLL_GROUPS.D10,
        },
        {
          value: ROLL_GROUPS.D6,
          label: localize("STORYDICE.RollGroup.D6"),
          selected: rollGroup === ROLL_GROUPS.D6,
        },
        {
          value: ROLL_GROUPS.ALL,
          label: localize("STORYDICE.RollGroup.All"),
          selected: rollGroup === ROLL_GROUPS.ALL,
        },
      ],
      statusText,
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("#story-dice-activate").click(this._onActivate.bind(this));
    html.find("#story-dice-deactivate").click(this._onDeactivate.bind(this));
    html.find("#story-dice-clear-history").click(this._onClearHistory.bind(this));
    html.find("#story-dice-roll-group").on("change", this._onRollGroupChange.bind(this));
    this._updateValueVisibility(html);
  }

  _onRollGroupChange(event) {
    const group = event.currentTarget.value;
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

  _updateValueVisibility(html) {
    const group = html.find("#story-dice-roll-group").val();
    const d10Group = html.find("#story-dice-d10-group");
    const d6Group = html.find("#story-dice-d6-group");

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

  async _onActivate(event) {
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

    await setSetting(SETTINGS.FUDGE_ACTIVE, true);
    await setSetting(SETTINGS.FUDGE_TARGET_USER_ID, targetUserId);
    await setSetting(SETTINGS.FUDGE_D10_VALUE, d10Value);
    await setSetting(SETTINGS.FUDGE_D6_VALUE, d6Value);
    await setSetting(SETTINGS.FUDGE_ROLL_GROUP, rollGroup);

    this.render();
  }

  async _onDeactivate(event) {
    event.preventDefault();
    await clearFudge();
    ui.notifications.info(localize("STORYDICE.Notify.FudgeCleared"));
    this.render();
  }

  async _onClearHistory(event) {
    event.preventDefault();
    await setSetting(SETTINGS.FUDGE_HISTORY, []);
    this.render();
  }

  async _updateObject(_event, _formData) {
    // Not used — activation is manual via button clicks
  }
}

// ---------------------------------------------------------------------------
// Scene control button (left sidebar)
// ---------------------------------------------------------------------------

function injectSceneControl() {
  Hooks.on("getSceneControlButtons", (controls) => {
    if (!game.user.isGM) return;
    controls.push({
      name: MODULE_ID,
      title: localize("STORYDICE.Control.ToolName"),
      icon: "fas fa-dice",
      layer: "notes",
      tools: [
        {
          name: "open-panel",
          title: localize("STORYDICE.Control.Title"),
          icon: "fas fa-dice-d20",
          onClick: () => {
            if (game.storydice) game.storydice.openPanel();
          },
          button: true,
        },
      ],
      visible: true,
    });
  });
}

// ---------------------------------------------------------------------------
// Actor sheet header button — inject next to the roll controls
// ---------------------------------------------------------------------------

function injectActorSheetButton() {
  Hooks.on("renderActorSheet", (_app, html, _data) => {
    if (!game.user.isGM) return;
    const actor = _app.object;
    if (actor?.type !== "character" && actor?.type !== "mook") return;

    const fudgeActive = setting(SETTINGS.FUDGE_ACTIVE);
    const container = html.find(".window-header .window-title");
    if (!container.length) return;

    const existing = container.parent().find(".story-dice-header-btn");
    if (existing.length) return;

    const cls = fudgeActive ? "story-dice-header-btn active" : "story-dice-header-btn";
    const btn = $(
      `<a class="${cls}" title="${localize("STORYDICE.Control.Title")}"><i class="fas fa-dice-d20"></i></a>`
    );
    btn.on("click", () => game.storydice.openPanel());
    btn.css({
      "margin-left": "auto",
      "margin-right": "4px",
      "cursor": "pointer",
      "opacity": fudgeActive ? "1" : "0.5",
    });
    container.parent().find(".window-title").after(btn);
  });
}

// ---------------------------------------------------------------------------
// Update panel (if open) when settings change
// ---------------------------------------------------------------------------

Hooks.on("updateSetting", (setting) => {
  if (!setting.key.startsWith(`${MODULE_ID}.`)) return;

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
      await setSetting(SETTINGS.FUDGE_ACTIVE, true);
      await setSetting(SETTINGS.FUDGE_TARGET_USER_ID, userId);
      await setSetting(SETTINGS.FUDGE_D10_VALUE, Math.clamped(d10Value ?? 1, 1, 10));
      await setSetting(SETTINGS.FUDGE_D6_VALUE, Math.clamped(d6Value ?? 1, 1, 6));
      await setSetting(SETTINGS.FUDGE_ROLL_GROUP, rollGroup ?? ROLL_GROUPS.ALL);
    },

    async deactivateFudge() {
      if (!game.user.isGM) return;
      await clearFudge();
    },

    isActive() {
      return setting(SETTINGS.FUDGE_ACTIVE);
    },

    getStatus() {
      return {
        active: setting(SETTINGS.FUDGE_ACTIVE),
        targetUserId: setting(SETTINGS.FUDGE_TARGET_USER_ID),
        d10Value: setting(SETTINGS.FUDGE_D10_VALUE),
        d6Value: setting(SETTINGS.FUDGE_D6_VALUE),
        rollGroup: setting(SETTINGS.FUDGE_ROLL_GROUP),
        history: setting(SETTINGS.FUDGE_HISTORY),
      };
    },
  };
}
