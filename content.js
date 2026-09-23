(function () {
  const SIDEBAR_ID = "resume-pro-sidebar";
  const SIDEBAR_PANEL_ID = "resume-pro-sidebar-panel";
  const SIDEBAR_DEFAULT_TOP = 96;
  const SIDEBAR_DEFAULT_RIGHT = 24;
  const STORAGE_KEYS = ["templates", "activeTemplateId", "aiConfig", "profile"];
  const FIELD_HIGHLIGHT_CLASS = "resume-pro__field-highlight";
  const FIELD_WAITING_CLASS = "resume-pro__field-waiting";
  const FIELD_ERROR_CLASS = "resume-pro__field-error";
  const FIELD_HIGHLIGHT_STYLE_ID = "resume-pro-field-highlight-styles";
  // AI 返回完整匹配计划后立即连续写入；进度文本与字段高亮仍会保留。
  const VISIBLE_FILL_INTERVAL_MS = 0;
  const FIELD_HIGHLIGHT_STYLE_TEXT = `
.${FIELD_HIGHLIGHT_CLASS} {
  animation: resume-pro-field-flash 1.9s cubic-bezier(0.22, 0.61, 0.36, 1) both !important;
  outline: 2px solid rgba(99, 102, 241, 0.92) !important;
  outline-offset: 3px !important;
  border-radius: 10px !important;
  background-image: linear-gradient(100deg, rgba(99, 102, 241, 0) 22%, rgba(56, 189, 248, 0.42) 50%, rgba(99, 102, 241, 0) 78%) !important;
  background-size: 250% 100% !important;
  background-repeat: no-repeat !important;
  background-position: 150% 0 !important;
  box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.45), 0 0 20px rgba(56, 189, 248, 0.45) !important;
}

.${FIELD_WAITING_CLASS} {
  animation: resume-pro-field-breathe 1.1s ease-in-out infinite !important;
  outline: 2px dashed rgba(56, 189, 248, 0.9) !important;
  outline-offset: 3px !important;
  border-radius: 10px !important;
}

.${FIELD_ERROR_CLASS} {
  animation: resume-pro-field-shake 0.5s cubic-bezier(0.36, 0.07, 0.19, 0.97) both !important;
  outline: 2px solid rgba(244, 63, 94, 0.9) !important;
  outline-offset: 3px !important;
  border-radius: 10px !important;
}

@keyframes resume-pro-field-flash {
  0% {
    background-position: 150% 0;
    box-shadow: 0 0 0 8px rgba(99, 102, 241, 0.16), 0 0 24px rgba(56, 189, 248, 0.55);
  }

  55% {
    background-position: -60% 0;
    outline-color: rgba(99, 102, 241, 1);
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.22), 0 0 30px rgba(56, 189, 248, 0.6);
  }

  100% {
    background-position: -160% 0;
    outline-color: rgba(99, 102, 241, 0);
    box-shadow: 0 0 0 0 rgba(99, 102, 241, 0), 0 0 8px rgba(56, 189, 248, 0);
  }
}

@keyframes resume-pro-field-breathe {
  0%, 100% { box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.12), 0 0 6px rgba(56, 189, 248, 0.35); }
  50% { box-shadow: 0 0 0 7px rgba(99, 102, 241, 0.16), 0 0 18px rgba(56, 189, 248, 0.75); }
}

@keyframes resume-pro-field-shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-4px); }
  40% { transform: translateX(4px); }
  60% { transform: translateX(-3px); }
  80% { transform: translateX(2px); }
}
  `;
  const fieldHighlightTimers = new WeakMap();
  const chipSelectionIdsByTarget = new WeakMap();
  const chipWriteTargets = new WeakSet();
  let shadowRoot = null;
  let sidebarVisible = true;
  const state = {
    dragOffsetX: 0,
    dragOffsetY: 0,
    dragging: false,
    sidebarUiState: null,
    currentStore: null,
    statusTimer: null,
    lastFocusedField: null,
    chipAction: null
  };

  const StorageService = {
    // 只读。每个网页加载都会跑一次，在这里写回会用这一刻的快照盖掉设置页刚存的内容；
    // 缺省值由设置页补。
    async ensureDefaults() {
      const current = await chrome.storage.local.get(STORAGE_KEYS);
      return normalizeStore(current);
    },

    async getState() {
      const current = await chrome.storage.local.get(STORAGE_KEYS);
      return normalizeStore(current);
    },

    async getSidebarUiState() {
      return self.ResumeProSidebarState.readOrDefault(chrome.storage.local);
    },

    async setSidebarUiState(uiState) {
      await self.ResumeProSidebarState.write(chrome.storage.local, uiState);
    },

    async setActiveTemplate(templateId) {
      await chrome.storage.local.set({ activeTemplateId: templateId });
    }
  };

  if (window.top !== window) {
    return;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "TOGGLE_SIDEBAR") return false;

    const sidebar = document.getElementById(SIDEBAR_ID);
    if (!sidebar) {
      sendResponse({ handled: false });
      return false;
    }

    sidebarVisible = !sidebarVisible;
    sidebar.hidden = !sidebarVisible;
    sendResponse({ handled: true, visible: sidebarVisible });
    return false;
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  async function init() {
    if (document.getElementById(SIDEBAR_ID)) {
      return;
    }

    [state.currentStore, state.sidebarUiState] = await Promise.all([
      StorageService.ensureDefaults(),
      StorageService.getSidebarUiState()
    ]);
    state.sidebarUiState = self.ResumeProSidebarState.normalize(state.sidebarUiState);
    const cssText = await fetch(chrome.runtime.getURL("content.css")).then((r) => r.text());
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    injectFieldHighlightStyles();
    createSidebar(sheet);
    renderSidebar();
    bindStorageSync();
    bindFocusTracking();
    window.addEventListener("resize", constrainSidebarToViewport);
  }

  function createSidebar(sheet) {
    const uiState = self.ResumeProSidebarState.normalize(state.sidebarUiState);
    state.sidebarUiState = uiState;
    const host = document.createElement("div");
    host.id = SIDEBAR_ID;
    Object.assign(host.style, {
      position: "fixed",
      top: `${SIDEBAR_DEFAULT_TOP}px`,
      right: `${SIDEBAR_DEFAULT_RIGHT}px`,
      zIndex: "2147483647"
    });

    if (uiState.left !== null && uiState.top !== null) {
      host.style.left = `${uiState.left}px`;
      host.style.top = `${uiState.top}px`;
      host.style.right = "auto";
    }

    document.body.appendChild(host);
    shadowRoot = host.attachShadow({ mode: "closed" });
    shadowRoot.adoptedStyleSheets = [sheet];

    const sidebar = document.createElement("aside");
    sidebar.id = SIDEBAR_PANEL_ID;
    sidebar.className = uiState.collapsed ? "resume-pro is-collapsed" : "resume-pro";
    sidebar.innerHTML = `
      <div class="resume-pro__header" data-drag-handle="true">
        <div class="resume-pro__title-wrap">
          <p class="resume-pro__eyebrow">简填.JIANTIAN</p>
          <strong class="resume-pro__title">简历自动填写助手</strong>
        </div>
        <button class="resume-pro__collapse" type="button" aria-label="折叠助手" aria-controls="${SIDEBAR_PANEL_ID}">−</button>
      </div>
      <div class="resume-pro__body">
        <label class="resume-pro__field">
          <span>当前基础信息</span>
          <select class="resume-pro__select" id="resume-pro-template-select"></select>
        </label>
        <button class="resume-pro__ai-button" id="resume-pro-ai-fill" type="button">一键 AI 填写</button>
        <button class="resume-pro__manager-button" id="resume-pro-repeat-fill" type="button">AI 辅助新增条目（先预览）</button>
        <button class="resume-pro__manager-button" id="resume-pro-cancel-fill" type="button" hidden>取消 AI 等待（保留本地匹配）</button>
        <p id="resume-pro-wait-hint" role="status" hidden></p>
        <div class="resume-pro__status" id="resume-pro-status" aria-live="polite"></div>
        <div class="resume-pro__fill-record" id="resume-pro-profile-offer" hidden>
          <p class="resume-pro__save-note" id="resume-pro-profile-offer-text"></p>
          <div class="resume-pro__save-actions">
            <button class="resume-pro__ai-button" type="button" id="resume-pro-profile-offer-add">加到我的信息</button>
            <button class="resume-pro__manager-button" type="button" id="resume-pro-profile-offer-skip">不用</button>
          </div>
        </div>
        <div class="resume-pro__fill-record" id="resume-pro-fill-record" hidden>
          <p class="resume-pro__save-note" id="resume-pro-fill-record-summary"></p>
          <label class="resume-pro__fill-record-option">
            <input type="checkbox" id="resume-pro-fill-record-snapshot" checked>
            <span>附上这次用的简历拷贝（先存在本机，传到桌面后可在申请里查看）</span>
          </label>
          <div class="resume-pro__save-actions">
            <button class="resume-pro__ai-button" type="button" id="resume-pro-fill-record-save">留档到桌面</button>
            <button class="resume-pro__manager-button" type="button" id="resume-pro-fill-record-skip">不留档</button>
          </div>
        </div>
        <details class="resume-pro__diagnostics" id="resume-pro-diagnostics" hidden>
          <summary>填写诊断（不含简历内容）</summary>
          <textarea id="resume-pro-diagnostics-text" readonly aria-label="填写诊断摘要，可选择复制" rows="14"></textarea>
        </details>
        <div class="resume-pro__divider"></div>
        <div class="resume-pro__desktop">
          <button class="resume-pro__manager-button" id="resume-pro-save-job" type="button">保存岗位到本地</button>
          <button class="resume-pro__manager-button" id="resume-pro-confirm-submit" type="button">确认已投递</button>
          <form class="resume-pro__save-form" id="resume-pro-save-form" hidden>
            <label class="resume-pro__field">
              <span>公司<em>*</em></span>
              <input type="text" id="resume-pro-save-company" autocomplete="off" required>
            </label>
            <label class="resume-pro__field">
              <span>岗位<em>*</em></span>
              <input type="text" id="resume-pro-save-title" autocomplete="off" required>
            </label>
            <label class="resume-pro__field">
              <span>地点</span>
              <input type="text" id="resume-pro-save-location" autocomplete="off">
            </label>
            <label class="resume-pro__field">
              <span>来源链接</span>
              <input type="text" id="resume-pro-save-url" readonly>
            </label>
            <p class="resume-pro__save-note" id="resume-pro-save-note"></p>
            <div class="resume-pro__save-actions">
              <button class="resume-pro__ai-button" type="submit">确认保存</button>
              <button class="resume-pro__manager-button" type="button" id="resume-pro-save-cancel">取消</button>
            </div>
          </form>
          <div class="resume-pro__candidates" id="resume-pro-candidates" hidden>
            <p class="resume-pro__save-note" id="resume-pro-candidates-note"></p>
            <div class="resume-pro__candidate-list" id="resume-pro-candidate-list"></div>
            <div class="resume-pro__save-actions">
              <button class="resume-pro__ai-button" type="button" id="resume-pro-bind-new">新建一条申请</button>
              <button class="resume-pro__manager-button" type="button" id="resume-pro-bind-later">稍后再说</button>
            </div>
          </div>
          <div class="resume-pro__desktop-status" id="resume-pro-desktop-status" aria-live="polite"></div>
          <details class="resume-pro__pending" id="resume-pro-pending" hidden>
            <summary>待同步 <span id="resume-pro-pending-count">0</span> 条</summary>
            <div class="resume-pro__pending-list" id="resume-pro-pending-list"></div>
          </details>
        </div>
        <div class="resume-pro__divider"></div>
        <section class="resume-pro__profile-summary" id="resume-pro-profile-summary"></section>
        <div class="resume-pro__resume-details" id="resume-pro-resume-details" hidden>
          <div class="resume-pro__resume-heading">完整基础信息（点击可填写）</div>
          <div class="resume-pro__groups" id="resume-pro-groups"></div>
        </div>
        <div class="resume-pro__footer">
          <button class="resume-pro__manager-button" id="resume-pro-open-manager" type="button">打开管理面板</button>
          <p class="resume-pro__footer-tip">管理面板会在新的浏览器标签页打开。</p>
        </div>
        </div>
      </div>
    `;

    shadowRoot.appendChild(sidebar);
    updateCollapseButton(sidebar);
    constrainSidebarToViewport();
    const chipActions = document.createElement("div");
    chipActions.id = "resume-pro-chip-actions";
    chipActions.className = "resume-pro__chip-actions";
    chipActions.hidden = true;
    chipActions.setAttribute("role", "menu");
    chipActions.setAttribute("aria-label", "字段填写方式");
    chipActions.innerHTML = `
      <button type="button" role="menuitem" data-chip-mode="add">添加</button>
      <button type="button" role="menuitem" data-chip-mode="replace">替换</button>
    `;
    shadowRoot.appendChild(chipActions);
    bindSidebarEvents(sidebar);
  }

  function bindSidebarEvents(sidebar) {
    const header = sidebar.querySelector(".resume-pro__header");
    const collapseButton = sidebar.querySelector(".resume-pro__collapse");
    const templateSelect = sidebar.querySelector("#resume-pro-template-select");
    const aiFillButton = sidebar.querySelector("#resume-pro-ai-fill");
    const openManagerButton = sidebar.querySelector("#resume-pro-open-manager");
    header.addEventListener("mousedown", startDrag);
    document.addEventListener("mousemove", onDrag);
    document.addEventListener("mouseup", stopDrag);

    collapseButton.addEventListener("click", () => {
      const host = document.getElementById(SIDEBAR_ID);
      if (!host) {
        return;
      }
      const rect = host.getBoundingClientRect();
      host.style.left = `${rect.left}px`;
      host.style.top = `${rect.top}px`;
      host.style.right = "auto";
      sidebar.classList.toggle("is-collapsed");
      updateCollapseButton(sidebar);
      persistSidebarUiState();
    });

    templateSelect.addEventListener("change", async (event) => {
      await StorageService.setActiveTemplate(event.target.value);
      showStatus("已切换当前使用的我的信息。", "success");
    });

    aiFillButton.addEventListener("click", handleAiFillClick);
    sidebar.querySelector("#resume-pro-repeat-fill").addEventListener("click", handleRepeatFillClick);
    openManagerButton?.addEventListener("click", () => openManager());
    sidebar.querySelector("#resume-pro-profile-offer-add")?.addEventListener("click", addUnansweredToProfile);
    sidebar.querySelector("#resume-pro-profile-offer-skip")?.addEventListener("click", closeProfileOffer);
    bindDesktopEvents(sidebar);

    const chipActions = shadowRoot.querySelector("#resume-pro-chip-actions");
    chipActions?.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    chipActions?.querySelectorAll("[data-chip-mode]").forEach((actionButton) => {
      actionButton.addEventListener("click", () => handleChipAction(actionButton.dataset.chipMode));
    });
    document.addEventListener("mousedown", () => closeChipActionMenu());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeChipActionMenu();
      }
    });
  }

  function bindStorageSync() {
    chrome.storage.onChanged.addListener(async (changes, areaName) => {
      if (areaName !== "local") {
        return;
      }

      if (changes.templates || changes.activeTemplateId || changes.aiConfig || changes.profile) {
        state.currentStore = await StorageService.getState();
        renderSidebar();
      }

      const sidebarStateChange = changes[self.ResumeProSidebarState.STORAGE_KEY];
      if (sidebarStateChange && !state.dragging) {
        state.sidebarUiState = self.ResumeProSidebarState.normalize(sidebarStateChange.newValue);
        applySidebarUiState();
      }
    });
  }

  function renderSidebar() {
    if (!shadowRoot) {
      return;
    }

    const templateSelect = shadowRoot.querySelector("#resume-pro-template-select");
    const groupsContainer = shadowRoot.querySelector("#resume-pro-groups");
    const resumeDetails = shadowRoot.querySelector("#resume-pro-resume-details");
    const profileSummary = shadowRoot.querySelector("#resume-pro-profile-summary");
    const activeTemplate = getActiveTemplate(state.currentStore);
    const templates = state.currentStore?.templates || [];

    templateSelect.innerHTML = templates.length
      ? templates.map((template) => `
          <option value="${escapeHtml(template.id)}" ${template.id === state.currentStore.activeTemplateId ? "selected" : ""}>
            ${escapeHtml(template.name)}
          </option>
        `).join("")
      : '<option value="">暂无我的信息</option>';

    templateSelect.disabled = !templates.length;

    const profile = activeProfile();
    const profileFields = profileResumeFields();
    resumeDetails.hidden = !profileFields.length;
    profileSummary.innerHTML = buildProfileSummaryHtml(profile);

    if (!profileFields.length) {
      groupsContainer.innerHTML = `
        <div class="resume-pro__empty">
          <p>当前基础信息还没有可用字段。</p>
          <button class="resume-pro__setup-button" id="resume-pro-setup-button" type="button">打开基础信息</button>
        </div>
      `;
    } else {
      groupsContainer.innerHTML = buildProfileChipsHtml(profileFields);

      groupsContainer.querySelectorAll(".resume-pro__chip").forEach((button) => {
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
        });
        button.addEventListener("click", () => handleFieldChipClick(button));
      });
    }

    const setupButton = groupsContainer.querySelector("#resume-pro-setup-button");
    if (setupButton) {
      setupButton.addEventListener("click", () => openManager());
    }

    closeChipActionMenu();
    syncChipSelectionState();
  }

  async function handleFieldChipClick(button) {
    const value = button.dataset.value || "";
    const target = getLastFocusedFillTarget();

    closeChipActionMenu();
    if (!value) {
      return;
    }

    if (!target) {
      await copyText(value);
      showStatus("请先点击网页中的输入框，再点击此信息。内容已复制，可直接粘贴。", "error");
      return;
    }

    target.focus?.();
    if (!isComposableTextTarget(target)) {
      await copyText(value);
      const filled = await Promise.resolve(setElementValue(target, value));
      if (filled) {
        target.focus?.();
        state.lastFocusedField = target;
      }
      return;
    }

    const selection = captureTextSelection(target);
    const currentValue = getComposableTargetValue(target);
    syncChipSelectionState();
    if (button.classList.contains("is-in-field")) {
      await applyChipValue(target, value, "remove", selection, button.dataset.chipId);
      return;
    }

    if (!currentValue) {
      await copyText(value);
      await applyChipValue(target, value, "add", selection, button.dataset.chipId);
      return;
    }

    showChipActionMenu(button, target, value, selection);
  }

  async function handleChipAction(mode) {
    const action = state.chipAction;
    closeChipActionMenu();
    if (!action || !["add", "replace"].includes(mode)) {
      return;
    }

    await copyText(action.value);
    const filled = await applyChipValue(action.target, action.value, mode, action.selection, action.button.dataset.chipId);
    if (!filled) {
      return;
    }
  }

  function showChipActionMenu(button, target, value, selection) {
    const menu = shadowRoot?.querySelector("#resume-pro-chip-actions");
    if (!menu) {
      return;
    }

    state.chipAction = { button, target, value, selection };
    menu.hidden = false;
    const buttonRect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(buttonRect.left, window.innerWidth - menuRect.width - 8));
    const fitsBelow = buttonRect.bottom + menuRect.height + 8 <= window.innerHeight;
    const top = fitsBelow ? buttonRect.bottom + 6 : Math.max(8, buttonRect.top - menuRect.height - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function closeChipActionMenu() {
    const menu = shadowRoot?.querySelector?.("#resume-pro-chip-actions");
    if (menu) {
      menu.hidden = true;
    }
    state.chipAction = null;
  }

  function captureTextSelection(target) {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const fallback = target.value.length;
      return {
        start: Number.isInteger(target.selectionStart) ? target.selectionStart : fallback,
        end: Number.isInteger(target.selectionEnd) ? target.selectionEnd : fallback
      };
    }

    const selection = window.getSelection?.();
    if (!selection?.rangeCount) {
      const fallback = target.textContent?.length || 0;
      return { start: fallback, end: fallback };
    }

    const range = selection.getRangeAt(0);
    if (!target.contains(range.commonAncestorContainer)) {
      const fallback = target.textContent?.length || 0;
      return { start: fallback, end: fallback };
    }

    const beforeStart = range.cloneRange();
    beforeStart.selectNodeContents(target);
    beforeStart.setEnd(range.startContainer, range.startOffset);
    const beforeEnd = range.cloneRange();
    beforeEnd.selectNodeContents(target);
    beforeEnd.setEnd(range.endContainer, range.endOffset);
    return { start: beforeStart.toString().length, end: beforeEnd.toString().length };
  }

  function composeChipText(currentValue, chipValue, mode, selection = {}) {
    const current = String(currentValue || "");
    const chip = String(chipValue || "");
    const rawStart = Number.isInteger(selection.start) ? selection.start : current.length;
    const start = Math.min(Math.max(0, rawStart), current.length);

    if (!chip) {
      return { value: current, caret: start, changed: false };
    }

    if (mode === "replace") {
      return { value: chip, caret: chip.length, changed: current !== chip };
    }

    if (mode === "remove") {
      const index = findNearestChipOccurrence(current, chip, start);
      if (index < 0) {
        return { value: current, caret: start, changed: false };
      }
      return {
        value: current.slice(0, index) + current.slice(index + chip.length),
        caret: index,
        changed: true
      };
    }

    return {
      value: current.slice(0, start) + chip + current.slice(start),
      caret: start + chip.length,
      changed: true
    };
  }

  function findNearestChipOccurrence(current, chip, caret) {
    let nearestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let index = current.indexOf(chip);
    while (index >= 0) {
      const distance = caret < index ? index - caret : caret > index + chip.length ? caret - (index + chip.length) : 0;
      if (distance < nearestDistance) {
        nearestIndex = index;
        nearestDistance = distance;
      }
      index = current.indexOf(chip, index + Math.max(1, chip.length));
    }
    return nearestIndex;
  }

  async function applyChipValue(target, chipValue, mode, selection, chipId = "") {
    if (!isComposableTextTarget(target) || !document.contains(target)) {
      return false;
    }

    const composed = composeChipText(getComposableTargetValue(target), chipValue, mode, selection);
    if (!composed.changed) {
      if (mode === "replace" && chipId) {
        updateTrackedChipSelection(target, chipId, mode);
        syncChipSelectionState();
        return true;
      }
      return false;
    }

    const hadTrackedSelection = chipSelectionIdsByTarget.has(target);
    const previousSelection = new Set(chipSelectionIdsByTarget.get(target) || []);
    updateTrackedChipSelection(target, chipId, mode);
    chipWriteTargets.add(target);
    let filled;
    try {
      filled = await Promise.resolve(setElementValue(target, composed.value));
    } finally {
      chipWriteTargets.delete(target);
    }
    if (!filled) {
      if (chipId) {
        if (hadTrackedSelection) {
          chipSelectionIdsByTarget.set(target, previousSelection);
        } else {
          chipSelectionIdsByTarget.delete(target);
        }
      }
      // chip 写不进去时也抖一下：和 AI 填写用同一套反馈，用户一眼知道这条没生效。
      applyFieldError(target);
      return false;
    }

    highlightFilledField(target, composed.value);
    target.focus?.();
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.setSelectionRange?.(composed.caret, composed.caret);
    } else {
      setContentEditableCaret(target, composed.caret);
    }
    state.lastFocusedField = target;
    syncChipSelectionState();
    return true;
  }

  function getComposableTargetValue(target) {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? String(target.value || "")
      : String(target.textContent || "");
  }

  function setContentEditableCaret(target, caret) {
    const selection = window.getSelection?.();
    const range = document.createRange?.();
    if (!selection || !range) {
      return;
    }
    const textNode = target.firstChild || target;
    const offset = textNode === target ? 0 : Math.min(caret, textNode.textContent?.length || 0);
    range.setStart(textNode, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function isComposableTextTarget(target) {
    if (target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) {
      return true;
    }
    return target instanceof HTMLInputElement && ["text", "search", "tel", "url", "email", "password"].includes(target.type || "text");
  }

  function syncChipSelectionState() {
    if (!shadowRoot?.querySelectorAll) {
      return;
    }
    const target = getLastFocusedFillTarget();
    const currentValue = target && isComposableTextTarget(target) ? getComposableTargetValue(target) : "";
    const buttons = Array.from(shadowRoot.querySelectorAll(".resume-pro__chip"));
    const selectedIds = target && isComposableTextTarget(target)
      ? resolveSelectedChipIds(target, buttons, currentValue)
      : new Set();
    buttons.forEach((button) => {
      const selected = selectedIds.has(button.dataset.chipId);
      button.classList.toggle("is-in-field", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }

  function updateTrackedChipSelection(target, chipId, mode) {
    if (!chipId) {
      return;
    }
    const selectedIds = new Set(chipSelectionIdsByTarget.get(target) || []);
    if (mode === "replace") {
      selectedIds.clear();
    }
    if (mode === "remove") {
      selectedIds.delete(chipId);
    } else {
      selectedIds.add(chipId);
    }
    chipSelectionIdsByTarget.set(target, selectedIds);
  }

  function resolveSelectedChipIds(target, buttons, currentValue) {
    const hasTrackedSelection = chipSelectionIdsByTarget.has(target);
    const previousIds = chipSelectionIdsByTarget.get(target) || new Set();
    const nextIds = new Set();
    const buttonsByValue = new Map();

    buttons.forEach((button, index) => {
      if (!button.dataset.chipId) {
        button.dataset.chipId = `rendered-chip-${index}`;
      }
      const value = button.dataset.value || "";
      if (!value) {
        return;
      }
      if (!buttonsByValue.has(value)) {
        buttonsByValue.set(value, []);
      }
      buttonsByValue.get(value).push(button);
    });

    buttonsByValue.forEach((sameValueButtons, value) => {
      let remaining = countTextOccurrences(currentValue, value);
      const preferred = sameValueButtons.filter((button) => previousIds.has(button.dataset.chipId));
      const candidates = hasTrackedSelection
        ? preferred
        : sameValueButtons;
      candidates.forEach((button) => {
        if (remaining > 0) {
          nextIds.add(button.dataset.chipId);
          remaining -= 1;
        }
      });
    });

    chipSelectionIdsByTarget.set(target, nextIds);
    return nextIds;
  }

  function countTextOccurrences(text, value) {
    if (!value) {
      return 0;
    }
    let count = 0;
    let index = String(text || "").indexOf(value);
    while (index >= 0) {
      count += 1;
      index = String(text || "").indexOf(value, index + value.length);
    }
    return count;
  }

  function newRequestId() {
    return crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join("-");
  }

  async function handleRepeatFillClick(event) {
    const button = event.currentTarget;
    const fillButton = shadowRoot.querySelector("#resume-pro-ai-fill");
    if (button.disabled || fillButton.disabled) return;
    const template = getActiveTemplate(state.currentStore);
    const config = state.currentStore?.aiConfig;
    if (!template || !config?.apiKey || !config?.apiUrl || !config?.model) {
      showStatus("请先准备我的信息和 AI 接口。", "error");
      return;
    }
    const agent = self.ResumeProFormAgent;
    const snapshot = agent.collect(document, flattenTemplateFields(template));
    if (!snapshot.candidates.length) {
      showStatus("未识别到可安全新增的分组，请先手动新增条目，再一键填写。", "error");
      return;
    }
    button.disabled = true;
    fillButton.disabled = true;
    const cancel = shadowRoot.querySelector("#resume-pro-cancel-fill");
    const hint = shadowRoot.querySelector("#resume-pro-wait-hint");
    const requestId = newRequestId();
    let stopped = false;
    let planning = true;
    let expanded;
    cancel.hidden = false;
    cancel.disabled = false;
    cancel.textContent = "停止辅助新增";
    cancel.onclick = () => {
      stopped = true;
      cancel.disabled = true;
      if (planning) self.ResumeProAIClient.cancel(requestId).catch(() => {});
    };
    const start = performance.now();
    const progress = () => {
      const seconds = Math.floor((performance.now() - start) / 1000);
      button.textContent = `AI 规划中... ${seconds}s`;
      if (seconds >= 90) {
        hint.hidden = false;
        hint.textContent = "正在等待 AI 规划，上游模型、中转或网络可能较慢；不会自动取消，可手动停止。";
      }
    };
    progress();
    const timer = window.setInterval(progress, 1000);
    try {
      const reply = await self.ResumeProAIClient.send({ type: "AI_PLAN_REPEAT", requestId, aiConfig: config, candidates: snapshot.candidates });
      planning = false;
      window.clearInterval(timer);
      if (stopped) throw new Error("已停止，未执行新增。");
      if (!reply?.success) throw new Error("AI 规划失败，未执行新增。可稍后重试或手动新增。");
      const plan = agent.validatePlan(reply.plan, snapshot.candidates);
      if (!plan.length) throw new Error("AI 未给出可确认的新增操作，请手动处理。");
      const preview = plan.map(action => `${snapshot.candidates.find(c => c.id === action.id).label}：${action.count} 条`).join("\n");
      if (!window.confirm(`允许以下操作吗？\n${preview}\n\n确认后将点击网页新增按钮，再用 AI 填写这些分组的空字段。不会提交、删除或覆盖已有内容。网页自身可能保存新条目；停止后不自动删除。`)) return;
      if (getActiveTemplate(state.currentStore) !== template) throw new Error("当前我的信息已变化，请重新预览。");
      button.textContent = "正在新增并检查网页...";
      hint.hidden = true;
      expanded = await agent.execute(plan, snapshot, () => stopped || getActiveTemplate(state.currentStore) !== template);
    } catch (error) {
      showStatus(error.message || "辅助新增失败，请手动核对网页。", "error");
    } finally {
      window.clearInterval(timer);
      cancel.hidden = true;
      cancel.onclick = null;
      cancel.textContent = "取消 AI 等待（保留本地匹配）";
      hint.hidden = true;
      button.disabled = false;
      fillButton.disabled = false;
      button.textContent = "AI 辅助新增条目（先预览）";
    }
    if (expanded && !stopped && getActiveTemplate(state.currentStore) === template) await handleAiFillClick({ currentTarget: fillButton }, { scopes: expanded.scopes });
  }

  function isAssistedTextField(entry) {
    const el = entry.element;
    return !el.disabled && !el.readOnly && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && ["text", "email", "tel", "url", "search"].includes(el.type)));
  }

  // 侧边栏读的是「当前这份我的信息」自带的基础信息（各方向独立保存）；没有的话退回全局那份。
  function activeProfile() {
    return self.ResumeProProfile?.entryProfile?.(state.currentStore) || state.currentStore?.profile || {};
  }

  async function ensureConfiguredEducationRows(profile, onProgress) {
    const records = Array.isArray(profile?.education)
      ? profile.education.filter((record) => record && Object.values(record).some((value) => String(value || "").trim()))
      : [];
    if (!records.length) return { added: 0, error: "" };

    let count = pageEducationRowCount();
    const needed = Math.max(0, records.length - count);
    if (!needed) return { added: 0, error: "" };

    const addButton = findEducationAddButton();
    if (!addButton) return { added: 0, error: "未找到“添加教育经历”按钮" };

    let added = 0;
    for (let index = 0; index < needed; index += 1) {
      onProgress?.(index + 1, needed);
      const before = count;
      addButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      addButton.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      addButton.click();
      const expanded = await waitPhoenixState(() => pageEducationRowCount() > before, 10, 100);
      if (!expanded) return { added, error: "网页未新增教育经历" };
      count = pageEducationRowCount();
      added += 1;
    }
    return { added, error: "" };
  }

  // 「添加/新增 …」类控件在不同组件库里可能是 button、a、span 甚至 div（北森就是 div/span）。
  // 统一挑最内层那个真正承载文字的元素，避免点到外层容器。
  function visibleAddRecordControls(scope, nounPattern) {
    const root = scope || document;
    return Array.from(root.querySelectorAll("button, [role='button'], a, span, div"))
      .filter((node) => {
        if (node.closest(`#${SIDEBAR_ID}`)) return false;
        const label = String(node.textContent || "").replace(/\s+/g, "");
        if (!/^[＋+加]?(添加|新增)[\u4e00-\u9fa5]{2,12}$/.test(label)) return false;
        if (nounPattern && !nounPattern.test(label)) return false;
        // 只要最内层：子元素里有同样文字的就不算。
        return !Array.from(node.children).some((child) => String(child.textContent || "").replace(/\s+/g, "") === label);
      })
      .filter((node) => isVisible(node));
  }

  // 教育/培训区块的范围：从“添加教育经历”这类按钮往上找，取仍然只包含本区块记录的那层祖先。
  // 逐层往上数记录，超过 6 条或开始包含别的区块就停下，避免把整页当成教育区块。
  function educationSectionScope() {
    const control = visibleAddRecordControls(null, /教育|培训/)[0];
    if (!control) return null;

    const countRecords = (scope) => Math.max(
      Array.from(scope.querySelectorAll("button, [role='button'], a"))
        .filter((node) => isVisible(node) && String(node.textContent || "").replace(/\s+/g, "").startsWith("删除")).length,
      Array.from(scope.querySelectorAll(".form-item, .form-item--phoenix"))
        .filter((item) => /学校|院校/.test(item.querySelector(".form-item__title .form-item__text")?.textContent || "")).length
    );

    let best = null;
    let node = control.parentElement;
    for (let depth = 0; depth < 8 && node; depth += 1) {
      const count = countRecords(node);
      if (count > 6) break;
      if (count > 0) best = node;
      node = node.parentElement;
    }
    return best;
  }

  function pageEducationRowCount() {
    const qqSheet = Array.from(document.querySelectorAll(".question.question-type-sheet"))
      .find((question) => /教育|培训/.test(question.innerText || ""));
    if (qqSheet) return qqSheet.querySelectorAll("tbody tr.sheet--line").length;

    // 北森等页面的教育记录没有 educationList.N 标记，只能按区块里的记录数来数：
    // 每条记录自带一个「删除」按钮，且第一个字段名通常是学校/院校。取两者较大值，
    // 只要点「添加教育经历」后这个数变大，就说明新增成功。
    const scope = educationSectionScope();
    if (scope) {
      const normalized = (node) => String(node?.textContent || "").replace(/\s+/g, "");
      const deletes = Array.from(scope.querySelectorAll("button, [role='button'], a"))
        .filter((node) => isVisible(node) && !node.closest(`#${SIDEBAR_ID}`) && normalized(node).startsWith("删除")).length;
      const schools = Array.from(scope.querySelectorAll(".form-item, .form-item--phoenix"))
        .filter((item) => /学校|院校/.test(item.querySelector(".form-item__title .form-item__text")?.textContent || "")).length;
      return Math.max(deletes, schools);
    }

    const indexes = new Set();
    document.querySelectorAll("label[for^='educationList.']").forEach((label) => {
      const match = label.getAttribute("for")?.match(/^educationList\.(\d+)\./);
      if (match) indexes.add(match[1]);
    });
    return indexes.size;
  }

  function findEducationAddButton() {
    const qqSheet = Array.from(document.querySelectorAll(".question.question-type-sheet"))
      .find((question) => /教育|培训/.test(question.innerText || ""));
    const qqAdd = qqSheet && Array.from(qqSheet.querySelectorAll("button, [role='button']"))
      .find((button) => isVisible(button) && normalizeAutocompleteText(button.textContent) === "新增一行");
    if (qqAdd) return qqAdd;

    const label = Array.from(document.querySelectorAll("span, button, [role='button']"))
      .find((node) => node instanceof HTMLElement
        && isVisible(node)
        && normalizeAutocompleteText(node.textContent) === "添加教育经历"
        && !node.closest(`#${SIDEBAR_ID}`));
    if (!label) return null;
    return label.closest("button, [role='button']") || label.parentElement;
  }

  function hasExistingValue(entry) {
    if (entry.kind === "radio") return entry.elements.some(el => el.checked);
    if (entry.kind === "custom-radio") return entry.elements.some((el) => el.getAttribute("aria-checked") === "true"
      || /(?:^|\\s)(?:is-checked|is-selected|phoenix-radio--checked)(?:\\s|$)/.test(el.className));
    const el = entry.element;
    if (!el?.isConnected) return true;
    if (el.type === "checkbox" || el.type === "radio") return el.checked;
    return Boolean(String(el.value ?? el.textContent ?? "").trim());
  }

  async function handleAiFillClick(event, assisted = null) {
    const button = event.currentTarget;
    if (button.disabled) return;
    const activeTemplate = getActiveTemplate(state.currentStore);
    const aiConfig = state.currentStore?.aiConfig;

    const profileFields = profileResumeFields();

    if (!activeTemplate && !profileFields.length) {
      showStatus("请先新建一份我的信息，或在「基础信息」里填写内容。", "error");
      return;
    }

    if (!aiConfig?.apiUrl || !aiConfig?.model || !aiConfig?.apiKey) {
      showStatus("请先在插件中配置 AI 接口。", "error");
      return;
    }

    button.disabled = true;
    // Warm the desktop modules while the fill runs, so that when it ends the page can be read
    // for the archive offer without waiting on anything (see offerFillRecord).
    loadDesktopModules().catch(() => {});
    const repeatButton = shadowRoot?.querySelector("#resume-pro-repeat-fill");
    if (repeatButton) repeatButton.disabled = true;
    button.textContent = "正在扫描网页...";
    // 用户点「一键填写」时所在的位置：网页在新增教育经历之后会自己把新行滚进视野，
    // 导致一按就跳到教育经历。填写开始前把位置放回去（见 restoreStartScroll）。
    const startScrollY = window.scrollY;
    const totalStart = performance.now();
    const timing = { scanMs: null, roundTripMs: null, fillMs: null };
    let phaseStart = totalStart;
    let phase = "scanMs";
    let timer = null;
    let diagnostics = {};
    let fieldCount = 0;
    let filledCount = 0;
    let unconfirmedCount = 0;
    const unfilledLabels = [];
    let outcome = "failed";
    const requestId = newRequestId();
    const cancelButton = shadowRoot?.querySelector("#resume-pro-cancel-fill");
    const waitHint = shadowRoot?.querySelector("#resume-pro-wait-hint");
    let cancelRequested = false;

    try {
      const hasConfiguredEducation = Array.isArray(activeProfile()?.education)
        && activeProfile().education.some((record) => record && Object.values(record).some((value) => String(value || "").trim()));
      if (!assisted && hasConfiguredEducation) {
        try {
          const educationResult = await ensureConfiguredEducationRows(activeProfile(), (current, total) => {
            button.textContent = `正在新增教育经历 ${current}/${total}...`;
          });
          if (educationResult.error) unfilledLabels.push(`教育经历（${educationResult.error}）`);
        } catch {
          // 新增按钮的网页实现各不相同；识别失败时仍继续填写当前已存在的字段。
          unfilledLabels.push("教育经历（网页新增操作异常）");
        }
      }
      // 新增完教育经历，网页可能已经滚到那边并聚焦了第一个输入框：把视野放回用户原来的位置。
      // 不 await：这一步只是视觉修正，不该拖慢（也不该阻塞）后面的扫描与匹配。
      restoreStartScroll(startScrollY);
      const scanned = scanFillableFields();
      const fieldMap = scanned.fieldMap;
      const fields = assisted ? scanned.fields.filter(field => {
        const entry = fieldMap.get(field.fieldId);
        return entry?.kind === "element" && isAssistedTextField(entry) && assisted.scopes.some(scope => scope.contains(entry.element)) && !hasExistingValue(entry);
      }) : scanned.fields;
      fieldCount = fields.length;
      timing.scanMs = performance.now() - phaseStart;
      phase = null;
      if (!fields.length) throw new Error("当前页面没有可填写的表单字段。");
      button.textContent = `已找到 ${fieldCount} 个可填字段，正在整理「${activeTemplate?.name || "我的信息"}」...`;
      if (!assisted) closeProfileOffer();
      // 我的信息字段在前并且优先；「基础信息」只补它没有的字段名。
      const templateFields = activeTemplate ? flattenTemplateFields(activeTemplate) : [];
      const resumeFields = self.ResumeProProfile
        ? self.ResumeProProfile.mergeResumeFields(templateFields, profileFields)
        : templateFields;
      phase = "roundTripMs";
      phaseStart = performance.now();
      if (cancelButton) {
        cancelButton.hidden = false;
        cancelButton.disabled = false;
        cancelButton.onclick = async () => {
          if (phase !== "roundTripMs") return;
          cancelButton.disabled = true;
          try {
            const reply = await self.ResumeProAIClient.cancel(requestId);
            if (reply?.cancelled) cancelRequested = true;
            if (waitHint && phase === "roundTripMs") {
              waitHint.hidden = false;
              waitHint.textContent = reply?.cancelled ? "正在取消 AI 等待，保留本地匹配结果。" : "请求已结束或无法取消，正在等待结果。";
            }
          } catch {
            if (phase === "roundTripMs") {
              cancelButton.disabled = false;
              if (waitHint) {
                waitHint.hidden = false;
                waitHint.textContent = "取消请求未送达，请重试；当前请求可能仍在等待。";
              }
            }
          }
        };
      }
      // 上一次这类页面的 AI 往返耗时（按模型分开记），用来给等待中的用户一个进度感。
      const lastAiMs = readLastAiDuration(aiConfig?.model);
      const updateProgress = () => {
        const elapsedMs = performance.now() - phaseStart;
        const seconds = Math.floor(elapsedMs / 1000);
        button.textContent = `AI 匹配中... ${seconds}s`;

        if (waitHint && !cancelRequested && seconds < 90) {
          const ratio = lastAiMs ? elapsedMs / lastAiMs : seconds / 60;
          const percent = Math.max(3, Math.min(96, Math.round(ratio * 100)));
          waitHint.hidden = false;
          waitHint.textContent = lastAiMs
            ? `正在等 AI 匹配：已送出 ${fieldCount} 个网页字段 · ${resumeFields.length} 个简历字段；上次这类页面约 ${Math.round(lastAiMs / 1000)}s，已到 ${percent}%`
            : `正在等 AI 匹配：已送出 ${fieldCount} 个网页字段 · ${resumeFields.length} 个简历字段；首次通常 30~90s`;
          // 测试替身没有 style，这里容错，不影响真机上的进度条。
          waitHint.style?.setProperty?.("--rp-progress", `${percent}%`);
        }

        if (seconds >= 90 && waitHint && !cancelRequested) {
          waitHint.hidden = false;
          waitHint.textContent = "AI 匹配尚未返回，等待通常与上游模型处理、中转服务或网络有关，输入量也会影响耗时。插件不会因等待较久自动取消；你可以继续等待或手动取消。";
        }
      };
      updateProgress();
      timer = window.setInterval(updateProgress, 1000);
      const response = await self.ResumeProAIClient.send({
        type: "AI_FILL",
        requestId,
        formFields: fields,
        resumeFields,
        aiConfig
      });
      timing.roundTripMs = performance.now() - phaseStart;
      phase = null;
      window.clearInterval(timer);
      timer = null;
      if (cancelButton) cancelButton.hidden = true;
      if (waitHint) waitHint.hidden = true;
      diagnostics = response?.diagnostics || {};

      if (!response?.success) {
        throw new Error(response?.error || "AI 填写失败。");
      }

      rememberAiDuration(aiConfig?.model, timing.roundTripMs);
      // 等待期间页面可能又因为别的异步渲染滚走了：开始填写前再放回原来的位置。
      restorePageScroll(startScrollY);
      button.textContent = Array.isArray(response.matches) && response.matches.length
        ? `AI 返回 ${response.matches.length} 项匹配，正在填写...`
        : "正在填写网页...";
      phase = "fillMs";
      phaseStart = performance.now();

      const fieldMetaMap = new Map(fields.map((f) => [f.fieldId, f]));
      const domOrderMap = new Map(fields.map((field, index) => [field.fieldId, index]));
      // AI 适合处理经历、项目等长文本；档案中明确配置的基础信息则本地补齐，
      // 避免模型漏掉“民族”“培养方式”“英语等级”这类一一对应字段。
      const allMatches = [
        ...response.matches,
        ...configuredFallbackMatches(fields, profileFields, response.matches)
      ];
      const sortedMatches = allMatches.sort((a, b) => {
        const ma = fieldMetaMap.get(a.fieldId);
        const mb = fieldMetaMap.get(b.fieldId);
        if (ma?.cascadeGroup !== undefined && ma.cascadeGroup === mb?.cascadeGroup) {
          return (ma.cascadeLevel ?? 0) - (mb.cascadeLevel ?? 0);
        }
        // 其余按页面顺序从上往下填：没被识别成联动组的省/市/县也能等上一级先选好。
        return (domOrderMap.get(a.fieldId) ?? 0) - (domOrderMap.get(b.fieldId) ?? 0);
      });

      // ④ 收尾补填用：第一遍没填上的下拉先记下来 —— 那时父级可能还没选，选项自然也是空的。
      const deferredSelectRetries = [];
      // ③ 收尾复查用：写成功的普通输入框记下来，填完再统一复查一遍「值还在不在」。
      const writtenPlainInputs = [];
      // 证件号码这类字段留到最后写：网页会在同区块其它字段变化时整段重渲染，把输入框节点换掉，
      // 先写进去的值随节点一起消失（实测：写完号码后点一下「性别」，号码就没了，而且没有任何代码
      // 去清它 —— 是节点被替换了）。见下面的「延迟写入」。
      const deferredIdFields = [];

      for (const [matchIndex, match] of sortedMatches.entries()) {
        if (assisted && getActiveTemplate(state.currentStore) !== activeTemplate) throw new Error("我的信息已变化，已停止辅助填写，请核对网页。");
        const element = fieldMap.get(match.fieldId);

        if (!element) continue;
        if (assisted && (!isAssistedTextField(element) || hasExistingValue(element) || !assisted.scopes.some(scope => scope.isConnected && scope.contains(element.element)))) continue;

        const fieldMeta = fieldMetaMap.get(match.fieldId);
        const fieldLabel = fieldMeta?.label || fieldMeta?.placeholder || fieldMeta?.name || "未命名字段";
        // AI 偶尔会把“出生日期”缩成 YYYY-MM。配置中的完整日期是确定数据，
        // 对这类日期字段优先使用它，避免让不完整的 AI 结果阻断填写。
        // 日期控件只收完整到日的值，所以先把「年月 / 区间」补全（见 resolveDateValue）。
        const plannedValue = resolveDateValue(fieldMeta, match.value, activeProfile(), profileFields);
        // 工作年限这类能从档案事实推出来的字段，推导值优先于 AI 的猜测。
        const derivedValue = resolveWorkYears(fieldMeta, activeProfile());
        const fillValue = adaptWebsiteValue(fieldMeta, derivedValue ?? plannedValue);
        if (isPlaceholderFillValue(fillValue)) {
          // 占位文本（「此处姓名」这类）不是资料。留空并说清楚，比填进去让用户以为已填好要安全。
          element.fillError = "占位文本，未填写";
          unfilledLabels.push(`${fieldLabel}（${element.fillError}）`);
          continue;
        }
        // 证件号码 / 身份证号 / 护照号：留到最后写（原因见 deferredIdFields 的注释）。
        if (fillValue && /证件号码|证件号|身份证号|身份证号码|护照号|护照号码/.test(fieldLabel)) {
          deferredIdFields.push({ label: fieldLabel, value: fillValue });
          continue;
        }

        button.textContent = `正在填写 ${matchIndex + 1}/${sortedMatches.length}：${fieldLabel}`;

        if (matchIndex > 0 && VISIBLE_FILL_INTERVAL_MS) {
          await new Promise((resolve) => window.setTimeout(resolve, VISIBLE_FILL_INTERVAL_MS));
        }

        let filled = false;
        try {
          filled = setElementValue(element, fillValue);
          if (filled instanceof Promise) {
            filled = await filled;
          }

          // ③ 写进去 ≠ 留得住。证件号码这类「下拉 + 输入框」组合控件会在事件处理完之后把值重置掉，
          // 只凭 setElementValue 返回 true 就报成功，用户会以为填好了。这里短暂回读一次：
          // 被清空 → 换成「聚焦 + 原生 setter + InputEvent」再写一次；还留不住就如实说清楚。
          if (filled && isReadableInput(element)) {
            filled = await valueSurvives(element.element, fillValue);
            if (!filled) {
              await writeThroughComponent(element.element, fillValue);
              filled = await valueSurvives(element.element, fillValue);
              if (!filled) {
                element.fillError = "网页把值清掉了，请手动粘贴";
              }
            }
          }

          if (assisted && filled) {
            await new Promise(resolve => window.setTimeout(resolve, 50));
            filled = element.element.isConnected && element.element.value === fillValue;
          }

          // ④ 联动下拉的选项是上一级选完才异步加载的，可能要等好几秒；一级学科这类还是 phoenix
          // 组件（不是原生 select），原来 450ms 的重试根本等不到。这里统一等：计划值还没出现在
          // 选项里就轮询（组件与原生都覆盖），等到就填，超时再如实说到不了位。
          if (!filled && isSelectLike(element)) {
            filled = await fillSelectWhenOptionsArrive(element, fillValue, fieldMeta, button, fieldLabel);
          }
        } catch {
          // 单个控件的脚本或网页组件异常不能中断后续字段填写。
          element.fillError = element.fillError || "填写操作异常";
          filled = false;
        }

        if (filled) {
          filledCount += 1;
          highlightFilledField(element, fillValue);

          if (isReadableInput(element)) {
            writtenPlainInputs.push({ element, label: fieldLabel });
          }
        } else if (assisted) {
          unconfirmedCount += 1;
          shakeField(element);
        } else {
          const unfilledNote = `${fieldLabel}${element.fillError ? `（${element.fillError}）` : ""}`;
          unfilledLabels.push(unfilledNote);
          if (element.fillError) shakeField(element);
          // 计划里本来就有值、只是没填上的下拉，留到收尾再试一轮（那时父级都填完了）。
          if (fillValue && isSelectLike(element)) {
            deferredSelectRetries.push({ element, value: fillValue, label: fieldLabel, note: unfilledNote, meta: fieldMeta });
          }
        }

        if (filled && fieldMeta?.cascadeGroup !== undefined) {
          const groupFields = fields.filter((f) => f.cascadeGroup === fieldMeta.cascadeGroup);
          const maxLevelInGroup = Math.max(...groupFields.map((f) => f.cascadeLevel));

          if (fieldMeta.cascadeLevel < maxLevelInGroup) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      }

      // ④ 收尾补填：第一遍填的时候上一级可能还没选、选项也还没加载（实测一级学科等 15.9s 仍为空）。
      // 等前面把父级都填完，再对「计划了值却没填上」的下拉重试一轮；成功就从「没填上」里划掉。
      for (const retry of deferredSelectRetries.slice(0, 8)) {
        if (cancelRequested) break;

        try {
          const retried = await fillSelectWhenOptionsArrive(retry.element, retry.value, retry.meta, button, retry.label);
          if (!retried) continue;

          filledCount += 1;
          const at = unfilledLabels.indexOf(retry.note);
          if (at >= 0) unfilledLabels.splice(at, 1);
          highlightFilledField(retry.element, retry.value);
        } catch {
          // 单个字段补填失败不影响其它字段与最终报告。
        }
      }

      // 证件类字段的延迟写入：网页重渲染会把输入框换成新节点，所以每次都要重新查一次 DOM，
      // 写完再重新查一次读回（拿着旧节点判断会误判成「被清掉」——这正是之前报假失败的原因）。
      for (const item of deferredIdFields) {
        try {
          let saved = false;
          let seen = false;

          for (let attempt = 0; attempt < 3 && !saved; attempt += 1) {
            const input = findInputByLabelText(item.label);

            if (!input) break;

            seen = true;
            await writeThroughComponent(input, item.value);
            if (canWaitForPage()) await new Promise((resolve) => window.setTimeout(resolve, 280));
            // 重新查一次 DOM 再读：网页重渲染会换掉节点，拿旧节点判断会误判。
            const fresh = findInputByLabelText(item.label);
            saved = Boolean(fresh && String(fresh.value ?? "").trim());
            if (saved) {
              filledCount += 1;
              highlightFilledField({ kind: "element", element: fresh }, item.value);
            }
          }

          if (saved) continue;

          if (!seen) {
            unfilledLabels.push(`${item.label}（网页上没找到这个输入框）`);
            continue;
          }

          unfilledLabels.push(`${item.label}（网页把值清掉了，请手动粘贴）`);
          const input = findInputByLabelText(item.label);
          if (input) shakeField({ kind: "element", element: input });
        } catch {
          unfilledLabels.push(`${item.label}（填写操作异常）`);
        }
      }

      // 证件类字段写入后可能被页面稍后的重渲染清掉（实测写成功、几秒后变空）。
      // 这里再等一拍复查一次：真的空了就重写一次，仍为空则如实报出，不保留假的成功计数。
      if (deferredIdFields.length) {
        if (canWaitForPage()) await new Promise((resolve) => window.setTimeout(resolve, 700));
        for (const item of deferredIdFields) {
          try {
            const input = findInputByLabelText(item.label);
            if (!input || String(input.value ?? "").trim()) continue;

            await writeThroughComponent(input, item.value);
            if (canWaitForPage()) await new Promise((resolve) => window.setTimeout(resolve, 300));
            const fresh = findInputByLabelText(item.label);
            if (fresh && String(fresh.value ?? "").trim()) continue;

            filledCount = Math.max(0, filledCount - 1);
            const note = `${item.label}（网页把值清掉了，请手动粘贴）`;
            if (!unfilledLabels.includes(note)) unfilledLabels.push(note);
            if (fresh) shakeField({ kind: "element", element: fresh });
          } catch {
            // 复查失败不扩大影响，只记录一次。
            const note = `${item.label}（填写操作异常）`;
            if (!unfilledLabels.includes(note)) unfilledLabels.push(note);
          }
        }
      }

      // ③ 收尾复查：有些组合控件会在几秒后把值清掉（实测证件号码写入时回读还在、约 3 秒后变空）。
      // 只在写入瞬间回读挡不住这种延迟清除，所以填完再统一复查一遍，把「其实是空着的」如实报出来。
      for (const item of writtenPlainInputs) {
        const input = item.element?.element;

        if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) continue;
        if (!input.isConnected) continue;
        if (String(input.value ?? "").trim()) continue;

        item.element.fillError = "网页把值清掉了，请手动粘贴";
        filledCount = Math.max(0, filledCount - 1);
        const note = `${item.label}（${item.element.fillError}）`;
        if (!unfilledLabels.includes(note)) unfilledLabels.push(note);
        shakeField(item.element);
      }

      outcome = response.warning || unconfirmedCount || unfilledLabels.length ? "partial" : "success";
      const unfilledNote = unfilledLabels.length
        ? `${unfilledLabels.length} 项没填上：${summarizeLabels(unfilledLabels)}，请手动补上。`
        : "";
      if (assisted) {
        showStatus(`辅助填写：已验证 ${filledCount} 项。${unconfirmedCount ? `${unconfirmedCount} 项未确认，请核对网页。` : ""}${response.warning || ""}`, outcome === "partial" ? "error" : "success");
      } else if (response.warning) {
        showStatus(`本地已填写 ${filledCount} 项；${unfilledNote}${response.warning}`, "error", Boolean(unfilledNote));
      } else if (unfilledNote) {
        // 没填上的字段要用户自己去补，提示不自动消失。
        showStatus(`已填写 ${filledCount} 个字段。${unfilledNote}`, "error", true);
      } else {
        showStatus(`已填写 ${filledCount} 个字段。`, "success");
      }

      if (!assisted) {
        const matchedIds = new Set(allMatches.map((match) => match.fieldId));
        offerUnansweredFields(fields.map((field) => ({
          label: field.label || field.placeholder || field.name,
          inputType: field.inputType,
          matched: matchedIds.has(field.fieldId),
          hasValue: hasExistingValue(fieldMap.get(field.fieldId)),
          entry: fieldMap.get(field.fieldId)
        })), resumeFields);
      }
    } catch (error) {
      showStatus(error.message || "AI 填写失败。", "error");
    } finally {
      if (cancelButton) {
        cancelButton.hidden = true;
        cancelButton.onclick = null;
      }
      if (waitHint) waitHint.hidden = true;
      if (timer !== null) window.clearInterval(timer);
      if (phase) timing[phase] = performance.now() - phaseStart;
      const totalMs = performance.now() - totalStart;
      const summary = formatFillDiagnostics({ ...timing, totalMs,
        fieldCount, filledCount, unfilledCount: unfilledLabels.length, outcome, diagnostics });
      const panel = shadowRoot?.querySelector("#resume-pro-diagnostics");
      const text = shadowRoot?.querySelector("#resume-pro-diagnostics-text");
      if (panel && text) {
        text.value = summary;
        panel.hidden = false;
        panel.open = true;
      }
      button.disabled = false;
      if (repeatButton) repeatButton.disabled = false;
      button.textContent = "一键 AI 填写";
      // A page with nothing to fill produced nothing worth archiving.
      if (fieldCount > 0) {
        offerFillRecord({
          outcome, cancelled: cancelRequested, fieldCount, filledCount, unconfirmedCount,
          timing: { scanMs: timing.scanMs, roundTripMs: timing.roundTripMs, fillMs: timing.fillMs, totalMs },
          templateName: activeTemplate?.name,
          endedAt: new Date().toISOString()
        }, activeTemplate).catch(() => {});
      }
    }
  }

  function summarizeLabels(labels, limit = 5) {
    const unique = [...new Set(labels.map((label) => String(label ?? "").trim()).filter(Boolean))];
    const shown = unique.slice(0, limit).join("、");
    return unique.length > limit ? `${shown} 等` : shown;
  }

  function formatFillDiagnostics(result) {
    const seconds = (value) => typeof value === "number" && Number.isFinite(value) ? `${(value / 1000).toFixed(2)} s` : "未执行 / 未取得";
    const count = (value) => Number.isInteger(value) && value >= 0 ? value : "未取得";
    const d = result.diagnostics;
    // Explicit allowlist: never copy provider messages, URL, keys or field values.
    const code = /^(none|cancelled|network|format|http_\d{3})$/.test(d.errorCode) ? d.errorCode : "unknown";
    return [
      `Resume Pro v${chrome.runtime.getManifest().version}`,
      `结果：${({ success: "完成", partial: "部分完成", failed: "失败" })[result.outcome] || "未知"}；错误类别：${code}`,
      `网页字段：${count(result.fieldCount)}；成功填写：${count(result.filledCount)}；没填上：${count(result.unfilledCount)}`,
      `本地匹配：${count(d.ruleMatches)}；AI 匹配：${count(d.aiMatches)}`,
      `送 AI 字段：${count(d.aiFields)}`,
      `候选 / 简历字段：${count(d.candidateFields)} / ${count(d.resumeFields)}`,
      `用户 prompt：${count(d.promptBytes)} bytes`,
      `扫描：${seconds(result.scanMs)}`,
      `匹配往返（含后台处理）：${seconds(result.roundTripMs)}`,
      `API（含响应读取）：${seconds(d.apiMs)}`,
      `填写：${seconds(result.fillMs)}；总计：${seconds(result.totalMs)}`
    ].join("\n");
  }

  function scanFillableFields() {
    const candidates = Array.from(document.querySelectorAll(
      "input:not([type='hidden']):not([type='file']):not([type='button']):not([type='submit']):not([type='reset']):not([disabled]), textarea:not([disabled]), select:not([disabled])"
    )).filter((element) => isVisible(element)
      && !element.closest(`#${SIDEBAR_ID}`)
      // 腾讯问卷教育矩阵在下面按表头逐格登记，避免所有单元格都被误标成整道题。
      && !element.closest(".question.question-type-sheet")
      // Phoenix 下拉里的 input 只用于搜索；由下面的 custom-select 作为一个完整字段处理。
      && !element.closest(".phoenix-select"));

    const fieldMap = new Map();
    const fields = [];
    const radioGroups = new Set();

    candidates.forEach((element, index) => {
      if (element instanceof HTMLInputElement && element.type === "radio") {
        const groupName = element.name || `__radio__${index}`;

        if (radioGroups.has(groupName)) {
          return;
        }

        radioGroups.add(groupName);
        const radioElements = candidates.filter((candidate) => candidate instanceof HTMLInputElement && candidate.type === "radio" && (candidate.name || `__radio__${index}`) === groupName);
        const fieldId = `field-radio-${fields.length}`;
        fieldMap.set(fieldId, { kind: "radio", elements: radioElements });
        fields.push({
          fieldId,
          label: getFieldLabel(element),
          placeholder: "",
          name: groupName,
          idAttr: "",
          ariaLabel: element.getAttribute("aria-label") || "",
          tagName: "input",
          inputType: "radio",
          options: radioElements.map((radio) => getRadioOptionLabel(radio)).filter(Boolean),
          group: findNearestGroupLabel(element)
        });
        return;
      }

      if (element instanceof HTMLInputElement && element.type === "checkbox") {
        const fieldId = `field-checkbox-${fields.length}`;
        fieldMap.set(fieldId, { kind: "checkbox", element });
        fields.push({
          fieldId,
          label: element.closest(".question") ? getTencentQuestionLabel(element) : getFieldLabel(element),
          placeholder: "",
          name: element.name || "",
          idAttr: element.id || "",
          ariaLabel: element.getAttribute("aria-label") || "",
          tagName: "input",
          inputType: "checkbox",
          options: [getRadioOptionLabel(element)].filter(Boolean),
          group: findNearestGroupLabel(element)
        });
        return;
      }

      const isTencentSelect = element instanceof HTMLInputElement
        && element.readOnly
        && element.matches(".t-input__inner")
        && element.closest(".question.question-type-select");
      const fieldId = `field-${fields.length}`;
      const fieldLabel = element.closest(".question") ? getTencentQuestionLabel(element)
        : (element.closest(".form-item--phoenix, .form-item") ? getPhoenixFieldLabel(element) : getFieldLabel(element));
      fieldMap.set(fieldId, isTencentSelect ? { kind: "tencent-select", element } : { kind: "element", element });
      fields.push({
        fieldId,
        // 腾讯问卷的每道题有稳定的 section.question 容器和 h2.question-title；
        // 普通回溯会误把上一道题的“全日制”等选项当成下一题输入框标签。
        label: fieldLabel,
        placeholder: element.getAttribute("placeholder") || "",
        name: element.getAttribute("name") || "",
        idAttr: element.id || "",
        ariaLabel: element.getAttribute("aria-label") || "",
        tagName: element.tagName.toLowerCase(),
        inputType: element instanceof HTMLInputElement ? element.type || "text" : element.tagName.toLowerCase(),
        options: element instanceof HTMLSelectElement
          ? Array.from(element.options).map((option) => option.text.trim()).filter(Boolean)
          : [],
        group: resolveRepeatGroup(element, fieldLabel) || findNearestGroupLabel(element)
      });
    });

    // Phoenix 等组件库会用 div 模拟单选框，页面中没有原生 input[type=radio]。
    // 这里把它们纳入与原生 radio 相同的字段扫描和 AI 匹配流程。
    document.querySelectorAll(".phoenix-radio-group").forEach((group) => {
      if (!isVisible(group) || group.closest(`#${SIDEBAR_ID}`) || group.querySelector('input[type="radio"]')) return;

      const radioItems = Array.from(group.querySelectorAll(".phoenix-radio"))
        .filter((item) => isVisible(item) && getPhoenixRadioOptionLabel(item));
      if (!radioItems.length) return;

      const fieldId = `field-custom-radio-${fields.length}`;
      fieldMap.set(fieldId, { kind: "custom-radio", elements: radioItems });
      fields.push({
        fieldId,
        label: getPhoenixFieldLabel(group),
        placeholder: "",
        name: group.getAttribute("name") || "",
        idAttr: group.id || "",
        ariaLabel: group.getAttribute("aria-label") || "",
        tagName: "div",
        inputType: "radio",
        options: radioItems.map((item) => getPhoenixRadioOptionLabel(item)),
        group: findNearestGroupLabel(group)
      });
    });

    document.querySelectorAll(".phoenix-select").forEach((select) => {
      if (!isVisible(select) || select.closest(`#${SIDEBAR_ID}`)) return;
      const searchInput = select.querySelector("input:not([disabled])");
      if (!searchInput) return;

      const fieldId = `field-custom-select-${fields.length}`;
      const selectLabel = getPhoenixFieldLabel(select);
      fieldMap.set(fieldId, { kind: "custom-select", element: select, input: searchInput });
      fields.push({
        fieldId,
        label: selectLabel,
        placeholder: searchInput.getAttribute("placeholder") || "",
        name: searchInput.getAttribute("name") || "",
        idAttr: select.id || "",
        ariaLabel: select.getAttribute("aria-label") || "",
        tagName: "div",
        inputType: "select",
        // 选项通常在点击后才渲染到页面浮层，因此让 AI 先按字段语义给出候选值，
        // 填写阶段再以页面实际出现的选项做精确校验。
        options: [],
        group: resolveRepeatGroup(select, selectLabel) || findNearestGroupLabel(select)
      });
    });

    document.querySelectorAll(".question.question-type-sheet").forEach((question) => {
      if (!/教育|培训/.test(question.innerText || "")) return;
      const headers = Array.from(question.querySelectorAll("thead th"))
        .map((header) => sanitizeLabelText(header.textContent));
      question.querySelectorAll("tbody tr.sheet--line").forEach((row, rowIndex) => {
        Array.from(row.querySelectorAll("td")).forEach((cell, cellIndex) => {
          const control = cell.querySelector("input:not([type='hidden']):not([disabled]), textarea:not([disabled])");
          const header = headers[cellIndex] || "";
          if (!control || !header) return;
          const fieldId = `field-${fields.length}`;
          const isTencentSelect = control instanceof HTMLInputElement && control.readOnly && control.matches(".t-input__inner");
          fieldMap.set(fieldId, isTencentSelect ? { kind: "tencent-select", element: control } : { kind: "element", element: control });
          fields.push({
            fieldId,
            label: header,
            placeholder: control.getAttribute("placeholder") || "",
            name: control.getAttribute("name") || "",
            idAttr: control.id || "",
            ariaLabel: control.getAttribute("aria-label") || "",
            tagName: control.tagName.toLowerCase(),
            inputType: isTencentSelect ? "select" : (control instanceof HTMLInputElement ? control.type || "text" : control.tagName.toLowerCase()),
            options: [],
            group: `教育经历${rowIndex + 1}`
          });
        });
      });
    });

    const pickerSelectors = [
      { selector: ".ant-picker", pickerType: "antd" },
      { selector: ".el-date-editor", pickerType: "element" },
      { selector: "[class*='date-picker']", pickerType: "generic" }
    ];

    pickerSelectors.forEach(({ selector, pickerType }) => {
      document.querySelectorAll(selector).forEach((container) => {
        if (container.closest(`#${SIDEBAR_ID}`)) return;
        if (!isVisible(container)) return;

        Array.from(container.querySelectorAll("input:not([type='hidden']):not([disabled])"))
          .filter((inner) => isVisible(inner))
          .forEach((inner) => {
          const pickerInputType = inferPickerInputType(container, inner);

          const existingEntry = Array.from(fieldMap.entries()).find(([, v]) => v.element === inner);
          if (existingEntry) {
            const [existingId, entryValue] = existingEntry;
            entryValue.pickerType = pickerType;
            entryValue.pickerInputType = pickerInputType;
            const existingField = fields.find((f) => f.fieldId === existingId);
            if (existingField) {
              existingField.inputType = "date-picker";
              existingField.pickerType = pickerType;
              existingField.pickerInputType = pickerInputType;
            }
            return;
          }

          const fieldId = `field-${fields.length}`;
          fieldMap.set(fieldId, { kind: "element", element: inner, pickerType, pickerInputType });
          fields.push({
            fieldId,
            label: getFieldLabel(inner),
            placeholder: inner.getAttribute("placeholder") || "",
            name: inner.getAttribute("name") || "",
            idAttr: inner.id || "",
            ariaLabel: inner.getAttribute("aria-label") || "",
            tagName: "input",
            inputType: "date-picker",
            pickerType,
            pickerInputType,
            options: [],
            group: findNearestGroupLabel(inner)
          });
        });
      });
    });

    // 级联判断 (Cascade Detection)
    if (self.ResumeProAIHelpers?.detectCascadeGroups) {
      self.ResumeProAIHelpers.detectCascadeGroups(fields, fieldMap);
    }

    return { fields, fieldMap };
  }

  function getTencentQuestionLabel(element) {
    const question = element.closest(".question");
    return sanitizeLabelText(question?.querySelector(".question-title .pe-line, .question-title .text, .question-title")?.textContent)
      || getFieldLabel(element);
  }

  function getFieldLabel(element) {
    const cleanedElementLabel = sanitizeLabelText(element.getAttribute("data-label"));
    if (cleanedElementLabel) return cleanedElementLabel;

    // 1. 标准 label 关联
    if (element.labels?.length) {
      const labelText = sanitizeLabelText(Array.from(element.labels).map((label) => label.textContent?.trim() || "").join(" / "));
      if (labelText) return labelText;
    }

    // 2. label[for] 关联
    if (element.id) {
      const linked = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      const linkedText = sanitizeLabelText(linked?.textContent);
      if (linkedText) return linkedText;
    }

    // 3. 包裹在 label 里
    const wrappingLabel = element.closest("label");
    const wrappingText = sanitizeLabelText(wrappingLabel?.textContent);
    if (wrappingText) return wrappingText;

    // 4. aria-labelledby
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = sanitizeLabelText(labelledBy.split(" ").map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" "));
      if (text) return text;
    }

    // 5. 同一行的前一个兄弟元素文本（td/th/span/div/p）
    let sibling = element.previousElementSibling;
    while (sibling) {
      const text = sanitizeLabelText(sibling.textContent);
      if (text && text.length < 30) return text;
      sibling = sibling.previousElementSibling;
    }

    // 6. 父容器内、input 之前的文本节点或标签元素（常见于 td 布局）
    const parent = element.parentElement;
    if (parent) {
      // 找父容器的前一个兄弟（如 th/td）
      let parentSibling = parent.previousElementSibling;
      while (parentSibling) {
        const text = sanitizeLabelText(parentSibling.textContent);
        if (text && text.length < 30) return text;
        parentSibling = parentSibling.previousElementSibling;
      }

      // 父容器本身的直接文本（排除 input 本身的内容）
      const clone = parent.cloneNode(true);
      clone.querySelectorAll("input, select, textarea, button").forEach(el => el.remove());
      const text = sanitizeLabelText(clone.textContent);
      if (text && text.length < 30) return text;
    }

    // 7. 向上追溯祖先容器的前序单元格/标签，适配表格或复杂布局
    let current = parent;
    let depth = 0;
    while (current && depth < 5) {
      let previous = current.previousElementSibling;
      while (previous) {
        const text = sanitizeLabelText(previous.textContent);
        if (text && text.length < 40) return text;
        previous = previous.previousElementSibling;
      }

      const scopedLabel = current.querySelector("label, th, .label, .form-label, .ant-form-item-label");
      const scopedText = sanitizeLabelText(scopedLabel?.textContent);
      if (scopedText && scopedText.length < 40) return scopedText;

      current = current.parentElement;
      depth += 1;
    }

    // 8. placeholder 兜底
    return element.getAttribute("placeholder")?.trim() || "";
  }

  // Phoenix 下拉框内部带着“请选择”等占位文字；通用标签回溯会过早把它当字段名。
  // 优先取同一 form-item 的标题，保证“出生日期”“最高学历”等能被正确送去匹配。
  function getPhoenixFieldLabel(element) {
    const formItem = element.closest(".form-item--phoenix, .form-item");
    const title = formItem?.querySelector(".form-item__title .form-item__text");
    const label = sanitizeLabelText(title?.textContent);
    return label || getFieldLabel(element);
  }

  function bindFocusTracking() {
    document.addEventListener("focusin", (event) => {
      const target = event.target;

      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (target.closest(`#${SIDEBAR_ID}`)) {
        return;
      }

      if (isFillTarget(target)) {
        state.lastFocusedField = target;
        closeChipActionMenu();
        syncChipSelectionState();
      }
    }, true);
    document.addEventListener("input", (event) => {
      if (event.target === state.lastFocusedField) {
        closeChipActionMenu();
        if (!chipWriteTargets.has(event.target)) {
          chipSelectionIdsByTarget.delete(event.target);
        }
        syncChipSelectionState();
      }
    }, true);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.setAttribute("readonly", "readonly");
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      const success = document.execCommand("copy");
      helper.remove();
      return success;
    }
  }

  function getLastFocusedFillTarget() {
    const candidates = [state.lastFocusedField, document.activeElement];

    for (const candidate of candidates) {
      if (candidate instanceof HTMLElement && isFillTarget(candidate) && document.contains(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  function hasRealSelectOptions(select) {
    const isPlaceholder = self.ResumeProAIHelpers?.isPlaceholderOption;
    return Array.from(select.options || []).some((option) => String(option.text ?? "").trim()
      && !(isPlaceholder && isPlaceholder({ value: option.value, text: option.text, disabled: option.disabled })));
  }

  function setElementValue(element, value) {
    if (element && typeof element === "object" && element.kind === "radio") {
      const radioOptions = element.elements.map((radio) => ({ value: radio.value, text: getRadioOptionLabel(radio), disabled: radio.disabled }));
      const radioIndex = self.ResumeProAIHelpers?.findSelectOptionIndex?.(radioOptions, value) ?? -1;
      const matchedRadio = radioIndex >= 0 ? element.elements[radioIndex] : null;

      if (!matchedRadio) {
        return false;
      }

      matchedRadio.checked = true;
      matchedRadio.dispatchEvent(new Event("input", { bubbles: true }));
      matchedRadio.dispatchEvent(new Event("change", { bubbles: true }));
      matchedRadio.click();
      return true;
    }

    if (element && typeof element === "object" && element.kind === "custom-radio") {
      const radioOptions = element.elements.map((item) => ({ value: getPhoenixRadioOptionLabel(item), text: getPhoenixRadioOptionLabel(item), disabled: item.getAttribute("aria-disabled") === "true" }));
      const radioIndex = self.ResumeProAIHelpers?.findSelectOptionIndex?.(radioOptions, value) ?? -1;
      const matchedRadio = radioIndex >= 0 ? element.elements[radioIndex] : null;

      if (!matchedRadio) return false;

      matchedRadio.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      matchedRadio.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      matchedRadio.click();
      return true;
    }

    if (element && typeof element === "object" && element.kind === "checkbox") {
      const checkbox = element.element;
      if (!(checkbox instanceof HTMLInputElement)) return false;
      if (!checkbox.checked) checkbox.click();
      return checkbox.checked;
    }

    if (element && typeof element === "object" && element.kind === "tencent-select") {
      return fillTencentSelect(element, value);
    }

    if (element && typeof element === "object" && element.kind === "custom-select") {
      markPhoenixSelectWaiting(element.element);
      return Promise.resolve(fillPhoenixSelect(element, value))
        .finally(() => clearPhoenixSelectWaiting(element.element));
    }

    const pickerType = (element && typeof element === "object" && element.kind === "element") ? element.pickerType : null;
    const pickerInputType = (element && typeof element === "object" && element.kind === "element") ? (element.pickerInputType || "date") : "date";

    if (element && typeof element === "object" && element.kind === "element") {
      element = element.element;
    }

    if (element instanceof HTMLInputElement && ["date", "month", "datetime-local", "time"].includes(element.type)) {
      const normalized = self.ResumeProAIHelpers?.normalizeDateValue?.(value, element.type) ?? value;
      const descriptor = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value");
      element.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
      if (descriptor?.set) {
        descriptor.set.call(element, normalized);
      } else {
        element.value = normalized;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      return element.value === normalized;
    }

    if (element instanceof HTMLInputElement && (pickerType === "antd" || pickerType === "element" || pickerType === "generic")) {
      const normalized = self.ResumeProAIHelpers?.normalizeDateValue?.(value, pickerInputType) ?? value;
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return new Promise((resolve) => {
        window.setTimeout(() => {
          try {
            const descriptor = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value");
            if (descriptor?.set) {
              descriptor.set.call(element, normalized);
            } else {
              element.value = normalized;
            }
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
            element.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
          } catch (_) {
            resolve(false);
            return;
          }
          resolve(element.value === normalized);
        }, 150);
      });
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      // 普通文本框也可能明确要求 YYYY-MM；仅按网页给出的格式裁剪。
      if (element instanceof HTMLInputElement && inferPickerInputType(element, element) === "month") {
        value = self.ResumeProAIHelpers?.normalizeDateValue?.(value, "month") ?? value;
      }
      const descriptor = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value");
      if (descriptor?.set) {
        descriptor.set.call(element, value);
      } else {
        element.value = value;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      if (element instanceof HTMLInputElement && !self.__RESUME_PRO_TEST__) {
        queueAutocompleteConfirmation(element, value);
      }
      return true;
    }

    if (element instanceof HTMLSelectElement) {
      const selectOptions = Array.from(element.options).map((option) => ({ value: option.value, text: option.text, disabled: option.disabled }));
      const optionIndex = self.ResumeProAIHelpers?.findSelectOptionIndex?.(selectOptions, value) ?? -1;
      const matchedOption = optionIndex >= 0 ? element.options[optionIndex] : null;

      if (!matchedOption) {
        return false;
      }

      // 走原型上的 setter：有些框架在实例上拦了 value，直接赋值会被吞掉。
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
      if (descriptor?.set) {
        descriptor.set.call(element, matchedOption.value);
      } else {
        element.value = matchedOption.value;
      }
      // 几个选项 value 相同时（常见的是一串空值），按 value 赋值会落到第一个，按下标补一次。
      if (element.selectedIndex !== optionIndex) {
        element.selectedIndex = optionIndex;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return element.selectedIndex === optionIndex;
    }

    if (element instanceof HTMLElement && element.isContentEditable) {
      element.textContent = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    return false;
  }

  // 某些网站（学校、专业、城市等）把输入框当作搜索框：写入文字后还必须选中
  // 下拉候选才算有效值。只点击可见的精确同名候选，绝不猜测或触碰提交按钮。
  function queueAutocompleteConfirmation(input, value, attempt = 0) {
    const expected = normalizeAutocompleteText(value);
    if (!expected) return;

    window.setTimeout(() => {
      if (!input.isConnected || normalizeAutocompleteText(input.value) !== expected) return;

      const option = findExactAutocompleteOption(input, expected);
      if (option) {
        option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        option.click();
        return;
      }

      // 页面可能在 input 事件后异步请求候选；最多再等两轮，避免持续轮询。
      if (attempt < 2) queueAutocompleteConfirmation(input, value, attempt + 1);
    }, 120);
  }

  function findExactAutocompleteOption(input, expected) {
    const roots = [];
    for (const attr of ["aria-controls", "aria-owns"]) {
      const id = input.getAttribute(attr);
      const controlled = id ? document.getElementById(id) : null;
      if (controlled) roots.push(controlled);
    }

    const selectors = [
      "[role='option']",
      "[role='listbox'] > *",
      "[class*='autocomplete' i] li",
      "[class*='autocomplete' i] [class*='item' i]",
      "[class*='suggest' i] li",
      "[class*='suggest' i] [class*='item' i]"
    ].join(",");

    const candidates = [
      ...roots.flatMap((root) => Array.from(root.querySelectorAll(selectors))),
      ...Array.from(document.querySelectorAll(selectors))
    ];

    return candidates.find((candidate) => candidate instanceof HTMLElement
      && isVisible(candidate)
      && normalizeAutocompleteText(candidate.textContent) === expected) || null;
  }

  function normalizeAutocompleteText(text) {
    return String(text || "").replace(/\s+/g, "").trim().toLocaleLowerCase();
  }

  async function fillTencentSelect(entry, value) {
    const input = entry?.element;
    if (!(input instanceof HTMLInputElement)) return false;
    entry.fillError = "";
    input.closest(".question")?.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    const trigger = input.closest(".t-input__wrap, .t-select") || input.parentElement;
    trigger?.click();
    const expected = normalizeAutocompleteText(value);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      const options = Array.from(document.querySelectorAll("li.t-select-option"))
        .filter((option) => isVisible(option));
      const matched = options.find((option) => normalizeAutocompleteText(option.textContent) === expected);
      if (!matched) continue;
      matched.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      matched.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      matched.click();
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      if (normalizeAutocompleteText(input.value) === expected) return true;
    }
    entry.fillError = "网页未确认已选中";
    return false;
  }

  async function fillPhoenixSelect(entry, value) {
    const select = entry.element;
    const input = entry.input;
    if (!(select instanceof HTMLElement) || !(input instanceof HTMLInputElement)) return false;
    entry.fillError = "";
    const monthOnly = inferPickerInputType(select, input) === "month";
    if (monthOnly) value = self.ResumeProAIHelpers?.normalizeDateValue?.(value, "month") ?? value;
    const dateParts = parsePhoenixDate(value);
    const isDate = Boolean(select.querySelector("[id$='field_date_time_picker']"))
      || /出生|生日|日期|毕业时间|入学时间|参加工作时间|到岗时间/.test(getPhoenixFieldLabel(select));

    select.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    select.click();
    await new Promise((resolve) => window.setTimeout(resolve, 80));

    // 同一页面上「年月」和「年月日」两种日期控件的静态 DOM 长得一模一样（同一个日历图标、空 placeholder），
    // 只有点开才看得出精度：网申里的「开始时间/结束时间」常是年月日历，出生日期/毕业时间才是年月日日历。
    // 所以先打开看真正挂出来的是哪种浮层，不再靠静态属性猜（以前猜错就把正确到月的计划值当成“不完整”拒收了）。
    const monthCalendar = await waitPhoenixState(() => findPhoenixMonthCalendar(select), 12);
    if (monthCalendar) {
      const yearMonth = dateParts || parseYearMonth(value);
      if (!yearMonth) {
        closePhoenixCalendar(monthCalendar, input);
        entry.fillError = "日期需完整到年月，如 YYYY-MM";
        return false;
      }
      try {
        return await confirmPhoenixMonthCalendar(monthCalendar, yearMonth, input, entry);
      } catch {
        entry.fillError = "日历操作失败，请手动选择";
        return false;
      } finally {
        const panel = findPhoenixMonthCalendar(select);
        if (panel) closePhoenixCalendar(panel, input);
      }
    }

    if (isDate && !monthOnly && !dateParts) {
      const openCalendar = findPhoenixCalendar();
      if (openCalendar) closePhoenixCalendar(openCalendar, input);
      entry.fillError = "日期需完整到日，如 YYYY-MM-DD";
      return false;
    }

    // 日历里的搜索输入框不代表已提交的值。日期只能走选取并验证的路径。
    if (!monthOnly && (isDate || dateParts)) {
      try {
        return await confirmPhoenixCalendarDate(dateParts, input, entry);
      } catch {
        entry.fillError = "日历操作失败，请手动选择";
        return false;
      } finally {
        const calendar = findPhoenixCalendar();
        if (calendar) closePhoenixCalendar(calendar, input);
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
    // 聚焦时不顺带滚动：否则填到页面中段的字段会把视野拽过去，用户会以为页面自己在乱跳。
    input.focus({ preventScroll: true });
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // Phoenix 的长选项下拉常把搜索框渲染在浮层里，字段内部 input 只是
    // 展示/提交值。同步写入浮层搜索框，确保“全日制”能筛出完整选项。
    setPhoenixPopupSearchValue(value);

    // 等候远程/异步筛选后的浮层。民族的虚拟列表可能在展开动画之后才挂载，
    // 因此给它更长的时间；每次都重新从 DOM 读取真实选项。
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      const option = findExactPhoenixSelectOption(value);
      if (option) {
        // 民族这类确认式单选器若目标本来已勾选，重复点击会取消它；普通下拉
        // 没有 RadioChecked，仍照常点击选项。
        if (!isPhoenixSelectorItemSelected(option)) {
          // 这套组件把「选中」绑在行首那个单选圆圈上：点整行、点文字都不生效（2026-09-19 在
          // bocd.zhiye.com 的民族选择器上实测确认），必须点 .icon-container 或它里面的 svg。
          // 但别的站点绑在整行或文字上，所以按顺序试；每试一次都用网页自己的状态（这一行变成
          // 已勾选）确认，避免「点了但没生效」被当成点好了。行会在选中后被网页重建，所以每次都
          // 重新按文字找一遍。
          const label = option.querySelector(".item-text-label") || option;
          const targets = [
            option.querySelector(".icon-container"),
            option.querySelector(".icon-container svg"),
            phoenixDeepestLabelNode(label, value),
            option
          ].filter(Boolean);
          for (const target of targets) {
            dispatchPhoenixPointerClick(target);
            const marked = await waitPhoenixState(() => {
              const current = findExactPhoenixSelectOption(value);
              return Boolean(current) && isPhoenixSelectorItemSelected(current);
            }, 2, 80);
            if (marked) break;
          }
        }
        // 普通下拉在点击选项后已完成；少数网站（如民族选择器）还会弹出
        // “已选… / 确定”的确认面板。保留普通下拉路径，同时识别并确认后者。
        const accepted = await confirmPhoenixSelectionIfNeeded(select, value);
        // 确认面板关掉、或外层字段真的显示了这个值，才算这次填写成功。
        const layer = phoenixPopupScope(option);
        const settled = await waitPhoenixState(() => phoenixSelectHasValue(select, value)
          || !option.isConnected
          || !isVisible(option)
          || (layer ? (!layer.isConnected || !isVisible(layer)) : false), 8, 120);
        if (accepted && settled) return true;
        // 这一版组件筛选是异步的：写进搜索框后列表会整段重建，刚才点到的行可能已经作废
        // （真机上出现过：点完没反应，但重扫一次再点就好）。所以这一轮不算数，重新扫描再来，
        // 直到用满 30 次；最后仍确认不了才如实报「未确认」，不假装填上了。
      }
    }

    entry.fillError = "网页未确认已选中，请手动选择";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    if (monthOnly) {
      const confirmed = await waitPhoenixState(() => {
        const selected = Array.from(select.querySelectorAll(".phoenix-select__tipEle, .phoenix-select__placeHolder"))
          .map(node => node.textContent?.trim()).filter(Boolean);
        return selected.length > 0 && selected.every(text => text === value);
      });
      if (confirmed) {
        entry.fillError = "";
        return true;
      }
      entry.fillError = entry.fillError || "网页未确认目标月份";
      return false;
    }
    const selected = await waitPhoenixState(() => phoenixSelectHasValue(select, value), 6);
    if (selected) {
      entry.fillError = "";
      return true;
    }
    entry.fillError = entry.fillError || "未找到网页中的对应选项";
    return false;
  }

  function parsePhoenixDate(value) {
    const normalized = String(value || "").trim().replace(/年|月/g, "-").replace(/日$/, "").replace(/\s/g, "");
    const match = normalized.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return { year, month, day };
  }

  function dateFieldKind(value) {
    const label = String(value || "").replace(/[\s:：*（）()【】[\]\-_/.·]+/g, "").toLowerCase();
    if (/出生年月|出生日期|生日|birth/.test(label)) return "birth";
    if (/毕业时间|毕业日期|graduation/.test(label)) return "graduation";
    if (/可到岗时间|到岗日期|availabledate/.test(label)) return "availableDate";
    return "";
  }

  function preferredConfiguredDate(fieldMeta, matchedValue, profileFields) {
    const kind = dateFieldKind(fieldMeta?.label || fieldMeta?.placeholder || fieldMeta?.name);
    if (!kind) return matchedValue;
    const configured = (Array.isArray(profileFields) ? profileFields : [])
      .find((field) => dateFieldKind(field?.key) === kind && parsePhoenixDate(field?.value));
    if (!configured) return matchedValue;
    const date = parsePhoenixDate(configured.value);
    return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
  }

  // 简历和 AI 计划里常见的日期是「年月」粒度（2023.09—2026.06、2026-06），而网申日期控件
  // 只接受完整到日的值。这里在写进网页之前把计划补成完整日期：
  //   1) 已是完整日期 —— 原样使用；
  //   2) 区间（简历里的教育/实习时间）—— 按字段语义取开始端或结束端；
  //   3) 年月 —— 先找档案里同一年月的真实日期（教育起止时间、毕业时间、参加工作时间），
  //      找不到才按语义补日（开始类当月 1 日、结束类当月最后一天）；
  //   4) 连年月都解析不出来 —— 退回按字段类型取档案里的完整日期。
  // 这样既不会把「2026-06」直接丢给只能收 YYYY-MM-DD 的日历控件，也不会凭空改掉 AI 的年份月份。
  function splitDateRange(value) {
    const text = String(value ?? "").trim();
    if (!text) return null;
    const parts = text.split(/\s*(?:—|–|～|~|至|到|\s-\s)\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.length >= 2 ? parts : null;
  }

  function dateRoleFromLabel(label) {
    const text = String(label ?? "");
    // 出生/生日没有「开始/结束」语义，靠档案里的出生日期兜底，不能套用区间的某一端。
    if (/结束|离职|离校|毕业时间|毕业日期|到期/.test(text)) return "end";
    if (/开始|起始|入学|入职|参加工作|上岗/.test(text)) return "start";
    return "";
  }

  function formatDateParts({ year, month, day }) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function dayFromYearMonth(year, month, role) {
    const day = role === "end" ? new Date(year, month, 0).getDate() : 1;
    return { year, month, day };
  }

  function parseYearMonth(value) {
    const normalized = String(value ?? "").trim().replace(/年|月/g, "-").replace(/日/g, "").replace(/\s/g, "").replace(/[-/.]+$/, "");
    const match = normalized.match(/^(\d{4})[-/.](\d{1,2})$/);
    if (!match) return null;
    const month = Number(match[2]);
    return month >= 1 && month <= 12 ? { year: Number(match[1]), month } : null;
  }

  function configuredDateEntries(profile) {
    const entries = [];
    const add = (value, role) => {
      const parts = parsePhoenixDate(value);
      if (parts) entries.push({ ...parts, role });
    };
    (Array.isArray(profile?.education) ? profile.education : []).forEach((row) => {
      add(row?.startTime, "start");
      add(row?.endTime, "end");
    });
    const values = profile?.values || {};
    add(values.birth, "birth");
    add(values.graduation, "graduation");
    add(values.availableDate, "availableDate");
    (Array.isArray(profile?.custom) ? profile.custom : []).forEach((row) => add(row?.value, ""));
    (Array.isArray(profile?.family) ? profile.family : []).forEach((row) => add(row?.birth, ""));
    return entries;
  }

  function resolveDateValue(fieldMeta, matchedValue, profile, profileFields) {
    const label = fieldMeta?.label || fieldMeta?.placeholder || fieldMeta?.name || "";
    if (!/时间|日期|出生|毕业|生日/.test(label)) return matchedValue;
    if (parsePhoenixDate(matchedValue)) return matchedValue;

    const role = dateRoleFromLabel(label);
    let planned = matchedValue;
    const range = splitDateRange(matchedValue);
    if (range && role) {
      planned = role === "start" ? range[0] : range[range.length - 1];
    }

    const month = parseYearMonth(planned);
    if (month) {
      const sameMonth = configuredDateEntries(profile)
        .filter((entry) => entry.year === month.year && entry.month === month.month);
      const unique = [...new Set(sameMonth.map(formatDateParts))];
      const configured = (role && sameMonth.find((entry) => entry.role === role))
        || (unique.length === 1 ? sameMonth[0] : null);
      return formatDateParts(configured || dayFromYearMonth(month.year, month.month, role));
    }

    // 连年月都解析不出来（例如出生日期被 AI 计划成了教育区间、或计划值为空）时，
    // 退回按字段类型取档案里的完整日期：先看合并后的档案字段，再看档案对象本身。
    const fromFields = preferredConfiguredDate(fieldMeta, matchedValue, profileFields);
    if (fromFields !== matchedValue) return fromFields;
    const kind = dateFieldKind(label);
    const byKind = { birth: profile?.values?.birth, graduation: profile?.values?.graduation, availableDate: profile?.values?.availableDate }[kind];
    const parts = parsePhoenixDate(byKind);
    return parts ? formatDateParts(parts) : matchedValue;
  }

  // 测试替身里的 setTimeout 是假定时器（要测试自己驱动），等它会挂住测试；
  // 真机上才做延迟回读，测试环境只做「微任务级」回读。
  function canWaitForPage() {
    return !self.__RESUME_PRO_TEST__;
  }

  // ③ 回读用：只有普通输入框 / 文本域的值能直接读回来判断「留没留住」。
  function isReadableInput(entry) {
    return entry?.kind === "element"
      && (entry.element instanceof HTMLInputElement || entry.element instanceof HTMLTextAreaElement)
      && !entry.element.readOnly
      && !entry.element.disabled;
  }

  // 写完之后值还在不在（组合控件会在事件之后把值清掉）。只判断「被清空」这一种：
  // 网页自己做的格式化（空格、大小写）不算失败，不然会把填好的字段误报成失败。
  async function valueSurvives(element, value) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return true;
    if (typeof element.value !== "string") return true;
    if (!String(value ?? "").trim()) return true;

    // 先在同一轮微任务里回读：组合控件在事件处理中同步清空值（React 在事件末尾刷 state）时，
    // 这一步就能发现，不必等定时器。
    await Promise.resolve();
    if (!element.isConnected) return false;
    if (String(element.value).trim()) return true;

    if (!canWaitForPage()) return false;

    // 有些组件会异步重新格式化值：再等一会儿，值回来了也算留住。
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      if (!element.isConnected) return false;
      if (String(element.value).trim()) return true;
    }

    return false;
  }

  // 只认「用户输入」的组件（证件号码这类）：聚焦 + 原生 setter + InputEvent，让它自己走一遍输入流程。
  // 不主动派发 blur —— 有些组件在 blur 时会把校验不过的值清掉，反而帮倒忙。
  async function writeThroughComponent(element, value) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;

    try {
      element.focus({ preventScroll: true });
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

      if (setter) setter.call(element, "");
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: "", inputType: "deleteContentBackward" }));

      if (setter) setter.call(element, value); else element.value = value;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value), inputType: "insertText" }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  // 下拉类字段：原生 select 与 phoenix 组件（kind=custom-select）都算。
  function isSelectLike(entry) {
    if (!entry) return false;
    if (entry.kind === "custom-select") return true;
    return entry.kind === "element" && entry.element instanceof HTMLSelectElement;
  }

  // 读当前下拉的选项文本（原生 select 与 phoenix 组件两种都覆盖）。
  function readSelectOptions(entry) {
    try {
      if (entry.kind === "element" && entry.element instanceof HTMLSelectElement) {
        return Array.from(entry.element.options).map((option) => String(option.textContent || option.text || "").trim());
      }

      if (entry.kind === "custom-select") {
        const scope = entry.element?.closest?.(".phoenix-select") || entry.element;
        const nodes = scope?.querySelectorAll?.(
          ".phoenix-select__option, .phoenix-select-option, [role='option'], .phoenix-select__item"
        );
        return Array.from(nodes || []).map((node) => String(node.textContent || "").trim());
      }
    } catch {
      // 组件内部结构异常时当作「读不到选项」，不要影响其它字段。
    }

    return [];
  }

  // ④ 选项是上一级选完才异步加载的，可能等好几秒。原来的重试只有 450ms 且只覆盖原生 select，
  // 一级学科这类 phoenix 组件因此永远等不到。这里：先试一次 → 选项还没出来就轮询等它变化 →
  // 变了再试。等待期间给用户一句明确提示，别让人以为卡住了。
  async function fillSelectWhenOptionsArrive(entry, value, fieldMeta, button, fieldLabel) {
    const wanted = String(value ?? "").trim();
    if (!wanted) return false;

    let filled = setElementValue(entry, value);
    if (filled instanceof Promise) filled = await filled;
    if (filled) return true;
    // 测试环境没有真定时器，别在这里等（真实网页上的等待时长在下面）。
    if (!canWaitForPage()) return false;

    const firstRead = readSelectOptions(entry);
    let lastSeen = firstRead.join("|");
    const looksLoaded = firstRead.some((text) => text && !/^请选择/.test(text));
    // 选项已经出来了、又不在联动组里：确实对不上，不白等。
    if (looksLoaded && fieldMeta?.cascadeGroup === undefined) return false;

    let hinted = false;
    const deadline = Date.now() + 6000;

    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 200));

      const currentRead = readSelectOptions(entry);
      const signature = currentRead.join("|");

      if (signature && signature !== lastSeen) {
        lastSeen = signature;
        filled = setElementValue(entry, value);
        if (filled instanceof Promise) filled = await filled;
        if (filled) return true;
      } else if (!hinted) {
        hinted = true;
        if (button) button.textContent = `等待网页加载「${fieldLabel}」的选项…`;
      }
    }

    return false;
  }

  // 档案里没有可用的工作年限时，按「参加工作时间」推导：还没到参加工作时间（或不足一年）→ 应届毕业生，
  // 否则按整年。这类由档案事实推导的值比让 AI 猜可靠，因此覆盖 AI 的计划值（实测 AI 会填「10年及以上」）。
  // 上一次 AI 往返耗时（按模型记在页面 localStorage 里）：等待时给用户一个「到哪了」的参考。
  const AI_DURATION_KEY_PREFIX = "resume-pro:ai-roundtrip-ms:";

  function readLastAiDuration(model) {
    try {
      const value = Number(window.localStorage?.getItem(`${AI_DURATION_KEY_PREFIX}${model || ""}`));
      return Number.isFinite(value) && value > 4000 ? value : 0;
    } catch {
      return 0;
    }
  }

  function rememberAiDuration(model, ms) {
    try {
      if (Number.isFinite(ms) && ms > 4000) {
        window.localStorage?.setItem(`${AI_DURATION_KEY_PREFIX}${model || ""}`, String(Math.round(ms)));
      }
    } catch {
      // 页面禁用 localStorage 时只是少一个参考时间，不影响填写。
    }
  }

  // 按「行里的文字」直接找输入框：网页重渲染会换节点，必须重新查；用行文本匹配比依赖扫描
  // 出来的标签更稳（实测扫描标签对证件号码这类组合控件可能对不上，导致找不到而误报「被清掉」）。
  function findInputByLabelText(labelText) {
    const want = String(labelText || "").trim();
    if (!want) return null;

    try {
      const rows = document.querySelectorAll(".form-item, .form-item--phoenix, [class*='form-item']");
      for (const row of rows) {
        if (!String(row.innerText || "").includes(want)) continue;

        const input = Array.from(row.querySelectorAll("input, textarea"))
          .find((node) => !node.disabled && node.type !== "hidden" && !node.readOnly && node.isConnected);

        if (input) return input;
      }
    } catch {
      // 网页结构异常时当作没找到，由调用方如实报出来。
    }

    return null;
  }

  // 按字段名重新在网页上找控件：网页重渲染会换掉节点，所以延迟写入/复查都必须重新查，不能用旧引用。
  function findFieldEntryByLabel(label) {
    const wanted = normalizeConfiguredFieldName(label);
    if (!wanted) return null;

    try {
      const scanned = scanFillableFields();
      for (const field of scanned.fields) {
        const entry = scanned.fieldMap.get(field.fieldId);
        if (!entry) continue;
        const name = normalizeConfiguredFieldName(entry.label || entry.placeholder || entry.name);
        if (name === wanted && entry.element?.isConnected) return entry;
      }
    } catch {
      // 扫描异常时当作没找到，由调用方决定怎么报。
    }

    return null;
  }

  // 这个字段现在还留着值吗（重新查 DOM 再读，避免拿到已被替换的旧节点）。
  function fieldHoldsValue(label) {
    const entry = findFieldEntryByLabel(label);
    if (!entry?.element) return false;
    const value = entry.element.value ?? entry.element.textContent ?? "";
    return Boolean(String(value).trim());
  }

  // 把视野放回用户点按钮时的位置（网页新增教育经历后会自己滚走）。
  function restorePageScroll(topY) {
    try {
      if (!Number.isFinite(topY) || !Number.isFinite(window.scrollY)) return;
      if (Math.abs(window.scrollY - topY) < 8) return;
      window.scrollTo({ top: topY, behavior: "auto" });
    } catch {
      // 个别页面禁止脚本滚动，忽略即可。
    }
  }

  async function restoreStartScroll(topY) {
    restorePageScroll(topY);
    if (!canWaitForPage()) return;
    // 网页那次聚焦滚动是异步发生的，稍后再补一次，确保用户眼前还是原来那一屏。
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    restorePageScroll(topY);
  }

  function resolveWorkYears(fieldMeta, profile) {
    const label = normalizeConfiguredFieldName(fieldMeta?.label || fieldMeta?.placeholder || fieldMeta?.name);
    if (!/工作年限|工作经验|工作年数/.test(label)) return null;
    const custom = (Array.isArray(profile?.custom) ? profile.custom : [])
      .find((item) => /参加工作|首次工作|入职/.test(String(item?.key ?? "")));
    const start = parsePhoenixDate(profile?.values?.workStart) || parsePhoenixDate(custom?.value);
    if (!start) return null;
    const today = new Date();
    const started = new Date(start.year, start.month - 1, start.day);
    let years = today.getFullYear() - start.year;
    if (today.getMonth() + 1 < start.month || (today.getMonth() + 1 === start.month && today.getDate() < start.day)) {
      years -= 1;
    }
    return started > today || years < 1 ? "应届毕业生" : `${years}年`;
  }

  // 占位文本（「此处姓名」这类）永远不写进网页：宁可留空让用户补，也不要把示例数据当成真实资料。
  function isPlaceholderFillValue(value) {
    return Boolean(self.ResumeProProfile?.isPlaceholderValue?.(value));
  }

  function adaptWebsiteValue(fieldMeta, value) {
    const label = normalizeConfiguredFieldName(fieldMeta?.label || fieldMeta?.placeholder || fieldMeta?.name);
    if (!/英语等级|外语等级|英语水平/.test(label)) return value;
    const level = normalizeConfiguredFieldName(value);
    const mapping = [
      [/^(?:cet|英语)?4(?:级)?$/, "四级"],
      [/^(?:cet|英语)?6(?:级)?$/, "六级"],
      [/^(?:tem|专业)?4(?:级)?$/, "专业四级"],
      [/^(?:tem|专业)?8(?:级)?$/, "专业八级"],
      [/^(?:ielts|雅思).*$/, "雅思"],
      [/^(?:toefl|托福).*$/, "托福"],
      [/^(?:toeic|托业).*$/, "托业"]
    ];
    return mapping.find(([pattern]) => pattern.test(level))?.[1] || value;
  }

  function normalizeConfiguredFieldName(value) {
    return String(value || "").toLowerCase().replace(/[\s:：*（）()【】[\]\-_/.·]+/g, "");
  }

  function configuredFallbackMatches(formFields, profileFields, existingMatches) {
    const usedIds = new Set((Array.isArray(existingMatches) ? existingMatches : []).map((match) => match.fieldId));
    const values = new Map((Array.isArray(profileFields) ? profileFields : []).map((field) => [normalizeConfiguredFieldName(field?.key), field?.value]));
    const schema = self.ResumeProProfile?.PROFILE_SCHEMA?.flatMap((group) => group.fields) || [];
    const safeIds = new Set([
      "gender", "birth", "ethnicity", "political", "marital", "idType", "idNumber", "height", "weight", "health", "seriousDisease", "nationality", "birthplace", "bloodType", "disability",
      "phone", "email", "highestEducation", "highestDegree", "studyMode", "schoolName", "discipline", "firstDiscipline", "majorName", "admission", "graduation", "gpa",
      "language", "languageLevel", "languageScore", "computerLevel", "computerCertificate", "drivingLicense", "professionalTitle", "workStart", "workYears", "expectedCity", "availableDate", "acceptAdjustment", "specialCategory", "selfEvaluation"
    ]);
    const fallback = [];

    for (const formField of formFields) {
      if (usedIds.has(formField.fieldId)) continue;
      const label = normalizeConfiguredFieldName(formField.label || formField.placeholder || formField.name);
      if (!label) continue;
      const definition = schema.find((field) => {
        if (!safeIds.has(field.id)) return false;
        const names = [field.key, field.label, ...(field.aliases || [])].map(normalizeConfiguredFieldName).filter(Boolean);
        return names.some((name) => name === label || (name.length >= 3 && (label.includes(name) || name.includes(label))));
      });
      if (!definition) continue;
      let value = values.get(normalizeConfiguredFieldName(definition.key));
      if (!value) continue;

      // “婚否”网页常给“是/否”，而档案存的是“已婚/未婚”。只有真实选项是是/否时转换。
      if (definition.id === "marital" && /婚否/.test(label) && Array.isArray(formField.options)) {
        const options = formField.options.map(normalizeConfiguredFieldName);
        if (options.includes("是") && options.includes("否")) {
          if (/^未婚|单身/.test(value)) value = "否";
          if (/^已婚/.test(value)) value = "是";
        }
      }
      fallback.push({ fieldId: formField.fieldId, value });
      usedIds.add(formField.fieldId);
    }
    return fallback;
  }

  function findPhoenixCalendar() {
    const panels = Array.from(document.querySelectorAll(".phoenix-calendar-date-panel"))
      .filter((panel) => panel instanceof HTMLElement && panel.isConnected && isVisible(panel));
    // 多个浮层同时打开时不猜测归属。
    return panels.length === 1 ? panels[0] : null;
  }

  // 「年月」精度的日历（.phoenix-calendar-month-calendar）和「年月日」日历的静态 DOM 几乎一样，
  // 只能打开后按挂出来的浮层判断。优先用当前字段自己的浮层，其次才用页面上唯一可见的那个。
  function isMonthCalendarPanel(panel) {
    // 用类名而非选择器判断：选择器在测试替身/未知浮层上可能返回任意节点，类名只属于真月历。
    return panel instanceof HTMLElement
      && panel.isConnected
      && isVisible(panel)
      && String(panel.className || "").includes("phoenix-calendar-month-calendar");
  }

  function findPhoenixMonthCalendar(scope) {
    const visible = (root) => Array.from(root.querySelectorAll(".phoenix-calendar-month-calendar"))
      .filter(isMonthCalendarPanel);
    if (scope instanceof HTMLElement && scope.isConnected) {
      const scoped = visible(scope);
      if (scoped.length === 1) return scoped[0];
      if (scoped.length > 1) return null;
    }
    const all = visible(document);
    return all.length === 1 ? all[0] : null;
  }

  function monthCalendarYear(calendar) {
    let text = "";
    try {
      text = calendar?.querySelector(".phoenix-calendar-month-panel-year-select-content")?.textContent
        || calendar?.querySelector(".phoenix-calendar-year-select")?.textContent
        || "";
    } catch {
      return null;
    }
    const value = Number(String(text).replace(/\D/g, ""));
    return Number.isInteger(value) && value > 1900 ? value : null;
  }

  async function confirmPhoenixMonthCalendar(calendar, { year, month }, input, entry) {
    let panel = calendar;

    // 一次跳一年，从当前年月走到目标年份（教育经历的起始时间常在几年前）。
    let safety = 0;
    while (monthCalendarYear(panel) !== year && safety++ < 80) {
      const current = monthCalendarYear(panel);
      if (current === null) { entry.fillError = "日历未切换到目标年月"; return false; }
      const button = panel.querySelector(current > year
        ? ".phoenix-calendar-prev-year-btn"
        : ".phoenix-calendar-next-year-btn");
      if (!(button instanceof HTMLElement)) { entry.fillError = "日历未切换到目标年月"; return false; }
      clickPhoenixCalendarElement(button);
      await waitPhoenixState(() => {
        const fresh = findPhoenixMonthCalendar(entry.element);
        if (fresh) panel = fresh;
        return monthCalendarYear(panel) === year;
      });
    }
    if (monthCalendarYear(panel) !== year) { entry.fillError = "日历未切换到目标年月"; return false; }

    const cell = Array.from(panel.querySelectorAll(".phoenix-calendar-month-panel-month"))
      .find((node) => node instanceof HTMLElement && (node.textContent || "").trim() === `${month}月`);
    if (!cell) { entry.fillError = "目标月份不可选"; return false; }

    // 读取组件自己渲染出来的年月文字，而不是被脚本赋值的 input.value。
    const committed = () => {
      const texts = [".phoenix-select__calcEle", ".phoenix-select__tipEle", ".phoenix-select__placeHolder"]
        .flatMap((selector) => Array.from(entry.element.querySelectorAll(selector)).map((node) => node.textContent || ""))
        .concat([input.value || ""]);
      return texts.some((text) => {
        const parts = parsePhoenixDate(text) || parseYearMonth(text);
        return Boolean(parts) && parts.year === year && parts.month === month;
      });
    };

    clickPhoenixCalendarElement(cell);
    if (!await waitPhoenixState(committed)) { entry.fillError = "网页未确认目标月份"; return false; }
    closePhoenixCalendar(panel, input);
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    if (!committed()) { entry.fillError = "月份失焦后回退"; return false; }
    return true;
  }

  async function waitPhoenixState(read, attempts = 20) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = read();
      if (result) return result;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    return null;
  }

  async function confirmPhoenixCalendarDate({ year, month, day }, input, entry) {
      let calendar = await waitPhoenixState(findPhoenixCalendar);
      if (!calendar) { entry.fillError = "未找到当前日历"; return false; }
      if (!await movePhoenixCalendarToMonth(calendar, year, month)) {
        entry.fillError = "日历未切换到目标年月";
        return false;
      }
      calendar = findPhoenixCalendar();
      const dayCell = Array.from(calendar?.querySelectorAll(
        "td.phoenix-calendar-cell:not(.phoenix-calendar-last-month-cell):not(.phoenix-calendar-next-month-btn-day) .phoenix-calendar-date"
      ) || []).find((cell) => cell instanceof HTMLElement
        && cell.textContent?.trim() === String(day)
        && cell.getAttribute("aria-disabled") !== "true");
      if (!dayCell) { entry.fillError = "目标日期不可选"; return false; }

      clickPhoenixCalendarElement(dayCell);
      // 读取组件渲染的已选文字，而非可被脚本直接赋值的 input.value。
      const committed = () => {
        const nodes = entry.element.querySelectorAll(".phoenix-select__tipEle, .phoenix-select__placeHolder");
        const dates = Array.from(nodes).map(node => parsePhoenixDate(node.textContent)).filter(Boolean);
        return dates.length > 0 && dates.every(date => date.year === year && date.month === month && date.day === day);
      };
      if (!await waitPhoenixState(committed)) {
        entry.fillError = "网页未确认目标日期";
        return false;
      }
      closePhoenixCalendar(calendar, input);
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      if (!committed()) { entry.fillError = "日期失焦后回退"; return false; }
      return true;
  }

  function readPhoenixCalendarMonth(calendar) {
    const year = Number(calendar.querySelector(".phoenix-calendar-year-select")?.textContent?.replace(/\D/g, ""));
    const month = Number(calendar.querySelector(".phoenix-calendar-month-select")?.textContent?.replace(/\D/g, ""));
    return Number.isInteger(year) && Number.isInteger(month) && month >= 1 && month <= 12 ? { year, month } : null;
  }

  async function movePhoenixCalendarToMonth(calendar, targetYear, targetMonth) {
    let current = readPhoenixCalendarMonth(calendar);
    if (!current) return false;

    // 年份按钮一次移动一年，避免从当前日期按月点到出生年份。
    let safety = 0;
    while (current.year !== targetYear && safety++ < 80) {
      const selector = current.year > targetYear
        ? ".phoenix-calendar-prev-year-btn"
        : ".phoenix-calendar-next-year-btn";
      const button = calendar.querySelector(selector);
      if (!(button instanceof HTMLElement)) return false;
      clickPhoenixCalendarElement(button);
      const next = await waitPhoenixState(() => {
        calendar = findPhoenixCalendar();
        const shown = calendar && readPhoenixCalendarMonth(calendar);
        return shown && shown.year !== current.year ? shown : null;
      });
      if (!next) return false;
      current = next;
    }
    if (current.year !== targetYear) return false;

    safety = 0;
    while (current.month !== targetMonth && safety++ < 12) {
      const selector = current.month > targetMonth
        ? ".phoenix-calendar-prev-month-btn"
        : ".phoenix-calendar-next-month-btn";
      const button = calendar.querySelector(selector);
      if (!(button instanceof HTMLElement)) return false;
      clickPhoenixCalendarElement(button);
      const next = await waitPhoenixState(() => {
        calendar = findPhoenixCalendar();
        const shown = calendar && readPhoenixCalendarMonth(calendar);
        return shown && (shown.year !== current.year || shown.month !== current.month) ? shown : null;
      });
      if (!next) return false;
      current = next;
    }
    return current.year === targetYear && current.month === targetMonth;
  }

  function clickPhoenixCalendarElement(element) {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    element.click();
  }

  function closePhoenixCalendar(calendar, input) {
    if (input?.isConnected) {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      // dispatchEvent 不会真的改变焦点，组件的“点击外部关闭”逻辑因此不会运行。
      input.blur();
    }

    const active = document.activeElement;
    if (active instanceof HTMLElement && calendar.contains(active)) {
      active.blur();
    }

    // Phoenix 日历没有确认按钮；它在失焦或 Escape 时关闭，同时保留已选择的日期。
    calendar.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    calendar.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    document.body.click();
  }

  function findExactPhoenixSelectOption(value) {
    const expected = normalizeAutocompleteText(value);
    if (!expected) return null;

    // 右侧「已选」区域会用同样的行标记展示已经选好的项，那不是可点的选项；
    // 另外这一版组件的选项行都带一个 .icon-container（行首单选圆圈），优先挑这种。
    const isSelectableItem = (item) => item instanceof HTMLElement && !item.closest(".select-data-container");
    const selectorLabelItems = Array.from(document.querySelectorAll(".item-text-label"))
      .map((label) => label instanceof HTMLElement ? label.closest(".list-item-container") : null)
      .filter((item) => isSelectableItem(item)
        && normalizeAutocompleteText(item.querySelector(".item-text-label")?.textContent) === expected);
    const itemsWithIcon = selectorLabelItems.filter((item) => item.querySelector(".icon-container"));
    const preferredItems = itemsWithIcon.length ? itemsWithIcon : selectorLabelItems;
    // 虚拟列表刚展开时，条目自身可能暂时没有布局尺寸；有可见项优先，
    // 没有时仍返回文字精确命中的已连接条目，避免 isVisible 的尺寸判断漏选。
    const labelSelectorItem = preferredItems.find((item) => isVisible(item)) || preferredItems[0];
    if (labelSelectorItem) return labelSelectorItem;

    // 某些页面把“民族”等选项绘制成自定义列表，而非标准 select option。
    // 优先按其实际文字节点找父项，避免被同一浮层的“已选”区域误匹配。
    const selectorItem = Array.from(document.querySelectorAll(".constant-main-selector-container .list-item-container"))
      .filter((item) => item instanceof HTMLElement && isVisible(item))
      .find((item) => normalizeAutocompleteText(item.querySelector(".item-text-label")?.textContent) === expected);
    if (selectorItem) return selectorItem;

    // 有些页面没有 constant-main-selector-container 外层，只有虚拟列表中的
    // list-item-container。限定为同时含有民族文字和单选图标的项，避免误点普通列表。
    const bareSelectorItems = Array.from(document.querySelectorAll(".list-item-container"))
      .filter((item) => item instanceof HTMLElement)
      .filter((item) => item.querySelector(".item-text-label, .icon-container svg"));
    const bareExact = bareSelectorItems.find((item) => normalizeAutocompleteText(item.querySelector(".item-text-label")?.textContent) === expected);
    if (bareExact) return bareExact;
    const bareIndex = self.ResumeProAIHelpers?.findSelectOptionIndex?.(
      bareSelectorItems.map((item) => ({ text: item.querySelector(".item-text-label")?.textContent, value: item.querySelector(".item-text-label")?.textContent })), value
    ) ?? -1;
    if (bareIndex >= 0) return bareSelectorItems[bareIndex];

    const selectors = [
      "[role='option']",
      ".phoenix-select__option",
      ".phoenix-select__menuItem",
      ".phoenix-selectList__listItem",
      // 民族等“左右已选确认”选择器的实际选项容器。
      ".constant-main-selector-container .list-item-container",
      "[class*='phoenix-select' i][class*='option' i]",
      "[class*='phoenix-select' i][class*='item' i]",
      "[class*='phoenix' i][class*='option' i]",
      "[class*='phoenix' i][class*='menu' i] [class*='item' i]",
      "[class*='phoenix' i][class*='dropdown' i] li",
      "[class*='select-menu' i] li",
      "[class*='select-dropdown' i] li"
    ].join(",");

    const candidates = Array.from(document.querySelectorAll(selectors))
      .filter((candidate) => candidate instanceof HTMLElement && isVisible(candidate));
    const exact = candidates.find((candidate) => normalizeAutocompleteText(candidate.textContent) === expected);
    if (exact) return exact;

    // 例如配置里的“全日制”对应网页的“全国普通高等院校全日制”。
    // 一个浮层可能同时保留虚拟列表、搜索结果和隐藏副本；这些相同文字不是
    // 多个语义候选，先去重再判断唯一性，避免把本可选中的全日制误判为歧义。
    const uniqueCandidates = [];
    const seenCandidateText = new Set();
    for (const candidate of candidates) {
      const normalized = normalizeAutocompleteText(candidate.textContent);
      if (!normalized || seenCandidateText.has(normalized)) continue;
      seenCandidateText.add(normalized);
      uniqueCandidates.push(candidate);
    }
    // 使用和原生 select 一样的唯一匹配规则，且会排除“非全日制”等反向选项。
    const optionIndex = self.ResumeProAIHelpers?.findSelectOptionIndex?.(
      uniqueCandidates.map((candidate) => ({ text: candidate.textContent, value: candidate.textContent })), value
    ) ?? -1;
    return optionIndex >= 0 ? uniqueCandidates[optionIndex] : null;
  }

  function setPhoenixPopupSearchValue(value) {
    let searchInputs = Array.from(document.querySelectorAll(
      ".phoenix-selectList__searchWrapper input, .phoenix-input.phoenix-search input, input[placeholder='搜索']"
    )).filter((node) => node instanceof HTMLInputElement && isVisible(node));
    if (!searchInputs.length) {
      // 组件改类名/改 placeholder 时，退回到“当前可见浮层里唯一那个输入框”。
      const layers = Array.from(document.querySelectorAll(
        ".common-unmodeled-layer, [class*='unmodeled'], [class*='selectList'], [class*='overlay'], [class*='layer']"
      )).filter((node) => node instanceof HTMLElement && isVisible(node));
      const inputs = layers.flatMap((layer) => Array.from(layer.querySelectorAll("input")))
        .filter((node) => node instanceof HTMLInputElement && isVisible(node));
      searchInputs = inputs.length === 1 ? inputs : [];
    }
    for (const searchInput of searchInputs) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (descriptor?.set) descriptor.set.call(searchInput, String(value ?? ""));
      else searchInput.value = String(value ?? "");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      searchInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // Phoenix 组件库常把勾选图标常驻在 DOM 里，只靠 CSS 控制显隐。只要节点存在就当作
  // “已勾选”，会让插件跳过点击（搜出来了却选不中），也会让确认判定误报成功。
  // 因此这里只认真正看得见的勾选，外加组件自己写在 DOM 上的选中状态。
  function phoenixItemShowsSelected(item) {
    if (!(item instanceof HTMLElement)) return false;
    if (item.getAttribute("aria-selected") === "true" || item.getAttribute("aria-checked") === "true") return true;
    const stateClass = /(?:^|[\s-])(?:is-checked|is-selected|is-active|checked|selected|active)(?:$|[\s-])/;
    for (let node = item, depth = 0; node instanceof HTMLElement && depth < 3; node = node.parentElement, depth += 1) {
      const className = typeof node.className === "string" ? node.className : "";
      if (className && stateClass.test(className)) return true;
    }
    if (item.querySelector("input[type='radio']:checked, input[type='checkbox']:checked")) return true;
    return Array.from(item.querySelectorAll("svg.RadioChecked, .RadioChecked")).some((mark) => {
      if (!(mark instanceof HTMLElement) || !isVisible(mark)) return false;
      const style = window.getComputedStyle(mark);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) !== 0;
    });
  }

  function isPhoenixSelectorItemSelected(item) {
    return phoenixItemShowsSelected(item);
  }

  // 从选项往上找一个“像浮层”的祖先，用来判断这块列表是不是已经收起来了。
  // 各站浮层类名并不统一（bocd.zhiye.com 用的是 phoenix-select-portal / phoenix-select__list），
  // 所以按关键字找；找不到就返回 null，由调用方退回只看字段显示值。
  function phoenixPopupScope(node) {
    const pattern = /layer|popup|popper|dropdown|overlay|portal|selector|select-?list|selectList|select__list|panel/i;
    let current = node instanceof HTMLElement ? node.parentElement : null;
    for (let depth = 0; current instanceof HTMLElement && depth < 8; current = current.parentElement, depth += 1) {
      const className = typeof current.className === "string" ? current.className : "";
      if (className && pattern.test(className)) return current;
    }
    return null;
  }

  // 和真人点一下等价的合成事件序列：按下 → 抬起 → click。
  function dispatchPhoenixPointerClick(target) {
    if (!(target instanceof Element)) return;
    const fire = (type, Ctor) => target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true }));
    fire("pointerdown", PointerEvent);
    fire("mousedown", MouseEvent);
    fire("mouseup", MouseEvent);
    // svg 上没有 click()（它是 HTMLElement 的方法），这种情况补一个 click 事件就够了 —— 事件照样冒泡。
    if (typeof target.click === "function") target.click();
    else fire("click", MouseEvent);
  }

  // 组件可能把事件绑在选项里更深一层的文字节点上。从最深的文字节点派发事件，
  // 事件会一路冒泡经过 label 和整条选项，绑在哪一层都能触发 —— 和真人点一下的效果一致。
  function phoenixDeepestLabelNode(label, value) {
    const expected = normalizeAutocompleteText(value);
    let node = label;
    for (let depth = 0; depth < 8 && node instanceof HTMLElement; depth += 1) {
      const next = Array.from(node.children).find((child) => normalizeAutocompleteText(child.textContent) === expected);
      if (!next) break;
      node = next;
    }
    return node;
  }

  function markPhoenixSelectWaiting(select) {
    if (select instanceof HTMLElement) select.classList.add(FIELD_WAITING_CLASS);
  }

  function clearPhoenixSelectWaiting(select) {
    if (select instanceof HTMLElement) select.classList.remove(FIELD_WAITING_CLASS);
  }

  function phoenixSelectHasValue(select, value) {
    const selectedTexts = Array.from(select.querySelectorAll(".phoenix-select__tipEle, .phoenix-select__calcEle, .phoenix-select__placeHolder"))
      .map((node) => node.textContent?.trim())
      .filter(Boolean);
    // 选中后网页会显示完整称谓（如“全国普通高等院校全日制”），配置则可能是
    // 简写“全日制”；确认结果也复用选项匹配规则，不能再强制逐字相同。
    return (self.ResumeProAIHelpers?.findSelectOptionIndex?.(selectedTexts, value) ?? -1) >= 0;
  }

  async function confirmPhoenixSelectionIfNeeded(select, value) {
    // Give normal selects a moment to commit before looking for a modal. This keeps
    // the prior click-only behavior intact for platforms without a confirmation step.
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    if (phoenixSelectHasValue(select, value)) return true;

    const confirmButton = findSelectionConfirmationButton(value);
    if (!confirmButton) return true;

    const confirmationPanel = confirmButton.closest(".common-unmodeled-layer")
      || confirmButton.closest(".selector-footer-button")?.parentElement?.parentElement;

    dispatchPhoenixPointerClick(confirmButton);

    // 确认式民族选择器提交后，值会回写到外层字段，原来的 select 节点不一定
    // 出现 tipEle；因此“弹层关闭”或“弹层内目标仍为 RadioChecked”都算成功。
    const confirmed = await waitPhoenixState(() => phoenixSelectHasValue(select, value)
      || !confirmationPanel?.isConnected
      || !isVisible(confirmationPanel)
      || phoenixSelectorHasSelectedValue(confirmationPanel, value), 30, 120);
    return Boolean(confirmed);
  }

  function findSelectionConfirmationButton(value) {
    const expected = normalizeAutocompleteText(value);
    if (!expected) return null;

    // 与民族选择器的 DOM 对齐：确定按钮本身是 div，不是原生 button。
    // 仅当右侧“已选”区域确实出现目标值时才点，防止误提交其他弹层。
    const directButton = Array.from(document.querySelectorAll(".selector-footer-button .phoenix-button__wraper--primary"))
      .filter((button) => button instanceof HTMLElement && isVisible(button))
      .find((button) => {
        if (String(button.textContent || "").replace(/\s+/g, "") !== "确定") return false;
        const panel = button.closest(".common-unmodeled-layer") || button.parentElement?.parentElement;
        const selected = panel?.querySelector(".select-data-container");
        return Boolean(
          (selected && !selected.querySelector(".select-data-empty")
            && normalizeAutocompleteText(selected.textContent).includes(expected))
          || phoenixSelectorHasSelectedValue(panel, value)
        );
      });
    // 真机实测（bocd.zhiye.com 民族选择器）：点击处理器挂在最深那层
    // div.phoenix-button__wraper--primary 上，它外面的 .phoenix-button /
    // .button-container / .selector-footer-button 都没有处理器。DOM 事件只向上冒泡，
    // 所以必须点最深的那层；点祖先节点是无效点击（这正是“已经选中了却提交不上”的原因）。
    if (directButton) return directButton;

    const candidates = Array.from(document.querySelectorAll("button, [role='button'], .phoenix-button, .phoenix-button__wraper"))
      .filter((button) => button instanceof HTMLElement && isVisible(button))
      .filter((button) => /^(确定|确认)$/.test(String(button.textContent || "").replace(/\s+/g, "")));
    const buttons = candidates.filter((button) => !candidates.some((other) => other !== button && button.contains(other)));

    return (buttons.length ? buttons : candidates).find((button) => {
      let panel = button.parentElement;
      // A confirmation button is safe to press only inside a selection panel that
      // explicitly displays the chosen item (e.g. “已选 1/1 … 汉族”).
      for (let depth = 0; panel && depth < 10; depth += 1, panel = panel.parentElement) {
        if (!isVisible(panel)) continue;
        const panelText = normalizeAutocompleteText(panel.textContent);
        if (/(已选|已选择|已勾选)/.test(panelText) && panelText.includes(expected)) return true;
      }
      return false;
    }) || null;
  }

  function phoenixSelectorHasSelectedValue(panel, value) {
    if (!(panel instanceof HTMLElement)) return false;
    const expected = normalizeAutocompleteText(value);
    return Array.from(panel.querySelectorAll(".list-item-container"))
      .some((item) => phoenixItemShowsSelected(item)
        && normalizeAutocompleteText(item.querySelector(".item-text-label")?.textContent) === expected);
  }

  function highlightFilledField(fieldEntry, value) {
    getHighlightTargets(fieldEntry, value).forEach((target) => {
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (!isInViewport(target)) {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        queueFieldHighlightWhenVisible(target);
        return;
      }

      applyFieldHighlight(target);
    });
  }

  function queueFieldHighlightWhenVisible(target, attempt = 0) {
    clearFieldHighlightTimer(target);
    const timer = window.setTimeout(() => {
      if (isInViewport(target) || attempt >= 18) {
        applyFieldHighlight(target);
        return;
      }

      queueFieldHighlightWhenVisible(target, attempt + 1);
    }, 100);
    fieldHighlightTimers.set(target, timer);
  }

  function applyFieldHighlight(target) {
    clearFieldHighlightTimer(target);
    target.classList.remove(FIELD_HIGHLIGHT_CLASS);
    void target.offsetWidth;
    target.classList.add(FIELD_HIGHLIGHT_CLASS);

    const timer = window.setTimeout(() => {
      target.classList.remove(FIELD_HIGHLIGHT_CLASS);
      fieldHighlightTimers.delete(target);
    }, 2800);
    fieldHighlightTimers.set(target, timer);
  }

  // 失败反馈：写不进去的字段抖一下 + 红框，和成功时的流光同属一套视觉语言。
  function applyFieldError(target) {
    if (!(target instanceof HTMLElement)) {
      return;
    }

    clearFieldHighlightTimer(target);
    target.classList.remove(FIELD_ERROR_CLASS);
    void target.offsetWidth;
    target.classList.add(FIELD_ERROR_CLASS);

    const timer = window.setTimeout(() => {
      target.classList.remove(FIELD_ERROR_CLASS);
      fieldHighlightTimers.delete(target);
    }, 900);
    fieldHighlightTimers.set(target, timer);
  }

  // 字段级失败反馈入口：传原始元素或字段条目都能用（和高亮走同一套目标解析）。
  function shakeField(fieldEntry) {
    getHighlightTargets(fieldEntry, fieldEntry?.element?.value || "").forEach((target) => {
      applyFieldError(target);
    });
  }

  function clearFieldHighlightTimer(target) {
    if (!fieldHighlightTimers.has(target)) {
      return;
    }

    window.clearTimeout(fieldHighlightTimers.get(target));
    fieldHighlightTimers.delete(target);
  }

  function getHighlightTargets(fieldEntry, value) {
    if (fieldEntry?.kind === "radio") {
      const trimmedValue = String(value || "").trim();
      const matchedRadio = fieldEntry.elements.find((radio) => {
        const optionText = getRadioOptionLabel(radio);
        return optionText === trimmedValue || radio.value === trimmedValue;
      });

      if (!matchedRadio) {
        return [];
      }

      return [matchedRadio.labels?.[0] || matchedRadio.closest("label") || matchedRadio];
    }

    if (fieldEntry?.kind === "custom-radio") {
      const trimmedValue = String(value || "").trim();
      const matchedRadio = fieldEntry.elements.find((radio) => getPhoenixRadioOptionLabel(radio) === trimmedValue);
      return matchedRadio ? [matchedRadio] : [];
    }

    const element = fieldEntry?.kind === "element" ? fieldEntry.element : fieldEntry;

    if (!(element instanceof HTMLElement)) {
      return [];
    }

    if (fieldEntry?.pickerType) {
      return [element.closest(".ant-picker, .el-date-editor, [class*='date-picker']") || element];
    }

    return [element];
  }

  function getPhoenixRadioOptionLabel(element) {
    return element.querySelector(".phoenix-radio__radio-text")?.textContent?.trim()
      || element.textContent?.trim()
      || "";
  }

  function isInViewport(element) {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0
      && rect.left >= 0
      && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight)
      && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
  }

  function injectFieldHighlightStyles() {
    if (document.getElementById(FIELD_HIGHLIGHT_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = FIELD_HIGHLIGHT_STYLE_ID;
    style.textContent = FIELD_HIGHLIGHT_STYLE_TEXT;
    (document.head || document.documentElement).appendChild(style);
  }

  function buildProfileSummaryHtml(profile) {
    const values = profile?.values || {};
    const rows = [["姓名", values.name], ["手机", values.phone], ["邮箱", values.email], ["最高学历", values.highestEducation || values.eduLevel], ["专业", values.majorName], ["学校", values.schoolName]].filter(([, value]) => value);
    return `<div class="resume-pro__profile-card"><div class="resume-pro__profile-card-title">当前基础信息</div><div class="resume-pro__profile-grid">${rows.length ? rows.map(([key, value]) => `<div><span>${escapeHtml(key)}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong></div>`).join("") : '<p>当前档案还没有基础信息</p>'}</div></div>`;
  }
  function buildTemplateGroupsHtml(template) {
    if (!template) return "";
    const groups = new Map();
    (template.groups || []).forEach((group) => {
      (group.fields || []).forEach((field) => {
        const label = String(field.key || "");
        const match = label.match(/^(.+?)(教育经历|项目经历|工作经历|实习经历|科研经历|在校经历|获奖情况|资格证书|论文期刊|专利|竞赛)[-：:](.+)$/);
        const entity = match ? `${match[1]}${match[2]}` : (group.name || "其他");
        const key = match ? match[3] : label;
        if (!groups.has(entity)) groups.set(entity, []);
        groups.get(entity).push({ ...field, key });
      });
    });
    return Array.from(groups, ([name, fields]) => `<section class="resume-pro__group"><div class="resume-pro__group-name">${escapeHtml(name)}</div><div class="resume-pro__chips">${fields.map((field, index) => `<button class="resume-pro__chip" type="button" data-chip-id="${escapeHtml(`${template.id}:${name}:${index}`)}" data-value="${escapeHtml(field.value)}" title="${escapeHtml(field.value)}">${escapeHtml(field.key)}</button>`).join("")}</div></section>`).join("");
  }
  function profileResumeFields() {
    const profile = activeProfile();
    return self.ResumeProProfile?.profileToResumeFields(profile) || [];
  }

  function groupProfileFieldsByEntity(profileFields) {
    const groups = new Map();
    const prefixes = ["华星电气有限公司", "高效电源转换项目", "反激式电源设计项目", "物联网时钟项目", "华北工业大学", "华北理工大学", "教育经历", "项目经历", "工作经历", "实习经历", "科研经历", "在校经历", "获奖情况", "资格证书", "论文期刊", "专利", "竞赛"];
    profileFields.forEach((field) => {
      const label = String(field.key || "");
      const prefix = prefixes.find((item) => label.startsWith(item));
      const name = prefix ? prefix : field.group;
      const cleanKey = prefix ? label.slice(prefix.length).replace(/^[-：:]/, "") || label : label;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push({ ...field, key: cleanKey });
    });
    return groups;
  }
  function buildProfileChipsHtml(profileFields) {
    const grouped = groupProfileFieldsByEntity(profileFields);
    return Array.from(grouped, ([name, groupFields]) => `
      <section class="resume-pro__group">
        <div class="resume-pro__group-name">我的信息 · ${escapeHtml(name)}</div>
        <div class="resume-pro__chips">
          ${groupFields.map((field) => `<button class="resume-pro__chip" type="button" data-chip-id="${escapeHtml(`profile:${name}:${field.key}`)}" data-value="${escapeHtml(field.value)}" title="${escapeHtml(field.value)}">${escapeHtml(field.key)}</button>`).join("")}
        </div>
      </section>
    `).join("");
  }

  // 填完之后，网页上没匹配上、也还空着的字段，问一句要不要加进「我的信息」。
  // 这样档案里的字段来自真实表单，用户补一次内容，下次同样的字段就能自动填。
  function offerUnansweredFields(candidates, resumeFields) {
    const api = self.ResumeProProfile;
    const card = shadowRoot?.querySelector("#resume-pro-profile-offer");
    if (!api || !card) return;

    const labels = api.pickUnansweredLabels(candidates, api.knownFieldKeys(activeProfile(), resumeFields));

    if (!labels.length) {
      closeProfileOffer();
      return;
    }

    state.profileOfferLabels = labels;
    state.profileOfferFields = resumeFields;
    state.profileOfferCandidates = candidates;
    const shown = labels.slice(0, 5).join("、");
    card.querySelector("#resume-pro-profile-offer-text").textContent =
      `网页上还有 ${labels.length} 个字段空着：${shown}${labels.length > 5 ? " 等" : ""}。加到「我的信息」并补上内容，下次就能自动填。`;
    card.hidden = false;
  }

  function closeProfileOffer() {
    const card = shadowRoot?.querySelector("#resume-pro-profile-offer");
    if (card) card.hidden = true;
    state.profileOfferLabels = [];
    state.profileOfferFields = [];
    state.profileOfferCandidates = [];
  }

  async function addUnansweredToProfile() {
    // 卡片出来之后用户可能已经手动填了几个，点的时候按网页现在的样子再挑一遍。
    const candidates = state.profileOfferCandidates || [];
    const labels = (state.profileOfferLabels || []).filter((label) => candidates.some((candidate) =>
      String(candidate.label ?? "").trim() === label && candidate.entry && !hasExistingValue(candidate.entry)));
    const resumeFields = state.profileOfferFields;

    if (!labels.length) {
      closeProfileOffer();
      showStatus("这些字段已经在网页上填好了。", "success");
      return;
    }

    try {
      // 用户点了才写：只改当前这份我的信息自带的基础信息，不碰简历内容、也不碰别的方向。
      const api = self.ResumeProProfile;
      const stored = await chrome.storage.local.get(["templates", "activeTemplateId", "profile"]);
      const entry = api.activeEntry(stored);
      const { profile, added, full } = api.addPendingFields(api.entryProfile(stored), labels, resumeFields);

      if (!added) {
        if (!full) closeProfileOffer();
        showStatus(full ? "补充字段已经满了，先在管理面板里删掉用不上的。" : "这些字段「我的信息」里已经有了。", full ? "error" : "success");
        return;
      }

      if (entry) {
        entry.profile = profile;
        await chrome.storage.local.set({ templates: stored.templates });
      } else {
        // 一份我的信息都还没有：先存全局那份，等第一份建出来时继承过去。
        await chrome.storage.local.set({ profile });
      }
      // 写成功才收起卡片；写失败时卡片留着，可以直接再点一次。
      closeProfileOffer();
      showStatus(`已把 ${added} 个字段加到当前这份我的信息，在管理面板里补上内容。`, "success", true);
      await openManager("profile");
    } catch (error) {
      showStatus(`没有加进去：${error.message || "写入失败"}`, "error");
    }
  }

  function flattenTemplateFields(template) {
    return template.groups.flatMap((group) => group.fields.map((field) => ({
      group: group.name,
      key: field.key,
      value: field.value
    })));
  }

  function getRadioOptionLabel(radio) {
    const directLabel = radio.labels?.[0]?.textContent?.trim();

    if (directLabel) {
      return directLabel;
    }

    const wrappingLabel = radio.closest("label")?.textContent?.trim();
    if (wrappingLabel) {
      return wrappingLabel;
    }

    return radio.value?.trim() || "";
  }

  // 重复记录区块（教育/工作/项目经历等）常常每条记录里字段名完全相同，
  // 只有区块的“添加X经历 / 新增一行”按钮能说明这是什么记录。
  // 这里按“区块名 + 同名字段序号”分组，让 AI 能把第 1 条和第 2 条教育经历分开。
  function findAddRecordControl(scope) {
    return visibleAddRecordControls(scope, /(经历|记录|行|项目|教育|工作|实习|获奖|证书|语言|成员|奖励)/)[0] || null;
  }

  function resolveRepeatGroup(element, label) {
    const clean = String(label || "").trim();
    if (!clean) return "";

    let node = element.closest(".form-item, .form-item--phoenix") || element;
    for (let depth = 0; depth < 8 && node; depth += 1) {
      node = node.parentElement;
      if (!node || node === document.body) break;

      const addControl = findAddRecordControl(node);
      if (!addControl) continue;

      const noun = String(addControl.textContent || "").replace(/\s+/g, "").replace(/^(添加|新增)/, "");
      if (!noun) continue;

      const sameLabel = Array.from(node.querySelectorAll(".form-item, .form-item--phoenix"))
        .filter((item) => sanitizeLabelText(item.querySelector(".form-item__title .form-item__text")?.textContent) === clean);
      if (sameLabel.length < 2) return noun;

      const ordinal = sameLabel.findIndex((item) => item.contains(element)) + 1;
      return `${noun}${ordinal || 1}`;
    }

    return "";
  }

  function findNearestGroupLabel(element) {
    // 牛客等页面的重复教育表单没有普通 section 标题，但 label 的 for 属性保留了
    // educationList.0 / educationList.1 索引。把它带给 AI，重复的“学校/专业”才不会串段。
    const educationRow = element.closest(".array-group");
    const educationFor = educationRow?.querySelector("label[for^='educationList.']")?.getAttribute("for") || "";
    const educationIndex = educationFor.match(/^educationList\.(\d+)\./)?.[1];
    if (educationIndex !== undefined) return `教育经历${Number(educationIndex) + 1}`;

    const sectionSelectors = ["fieldset", "[role='group']", ".form-item", ".ant-form-item", "tr", "li", "section", "td"];

    for (const selector of sectionSelectors) {
      const container = element.closest(selector);

      if (!container) {
        continue;
      }

      const labelCandidate = container.querySelector("legend, label, th, .label, .form-label, .ant-form-item-label");
      const text = labelCandidate?.textContent?.trim().replace(/[*\s]+$/g, "").trim();

      if (text && text.length < 40) {
        return text;
      }
    }

    return "";
  }

  function sanitizeLabelText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/^\*+/, "")
      .replace(/\*+$/g, "")
      .trim();
  }

  async function openManager(tab = "") {
    try {
      const result = await chrome.runtime.sendMessage({ type: "OPEN_MANAGER", tab });
      if (!result?.opened) {
        showStatus(result?.error || "无法打开管理面板，请从浏览器工具栏点击 Resume Pro。", "error");
      }
    } catch {
      showStatus("无法打开管理面板，请从浏览器工具栏点击 Resume Pro。", "error");
    }
  }

  function isFillTarget(target) {
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    );
  }

  function getActiveTemplate(store) {
    if (!store?.templates?.length) {
      return null;
    }

    return store.templates.find((template) => template.id === store.activeTemplateId) || store.templates[0];
  }

  function showStatus(message, variant, persist = false) {
    const statusElement = shadowRoot?.querySelector("#resume-pro-status");

    if (!statusElement) {
      return;
    }

    statusElement.textContent = message;
    statusElement.className = `resume-pro__status is-visible is-${variant}`;

    if (state.statusTimer) {
      clearTimeout(state.statusTimer);
      state.statusTimer = null;
    }

    if (persist) {
      return;
    }

    state.statusTimer = window.setTimeout(() => {
      statusElement.className = "resume-pro__status";
      statusElement.textContent = "";
    }, 2400);
  }

  function startDrag(event) {
    if (event.target.closest("button, select, input")) {
      return;
    }

    const host = document.getElementById(SIDEBAR_ID);
    const rect = host.getBoundingClientRect();
    state.dragging = true;
    state.dragOffsetX = event.clientX - rect.left;
    state.dragOffsetY = event.clientY - rect.top;
    shadowRoot?.querySelector(".resume-pro")?.classList.add("is-dragging");
  }

  function onDrag(event) {
    if (!state.dragging) {
      return;
    }

    const sidebar = document.getElementById(SIDEBAR_ID);
    const width = sidebar.offsetWidth;
    const height = sidebar.offsetHeight;
    const nextLeft = clamp(event.clientX - state.dragOffsetX, 12, window.innerWidth - width - 12);
    const nextTop = clamp(event.clientY - state.dragOffsetY, 12, window.innerHeight - height - 12);

    sidebar.style.left = `${nextLeft}px`;
    sidebar.style.top = `${nextTop}px`;
    sidebar.style.right = "auto";
  }

  function stopDrag() {
    if (!state.dragging) {
      return;
    }

    state.dragging = false;
    shadowRoot?.querySelector(".resume-pro")?.classList.remove("is-dragging");
    persistSidebarUiState();
  }

  function updateCollapseButton(sidebar = shadowRoot?.querySelector(".resume-pro")) {
    const collapseButton = sidebar?.querySelector(".resume-pro__collapse");
    if (!collapseButton) {
      return;
    }

    const collapsed = sidebar.classList.contains("is-collapsed");
    collapseButton.textContent = collapsed ? "+" : "−";
    collapseButton.setAttribute("aria-label", collapsed ? "展开助手" : "折叠助手");
    collapseButton.setAttribute("aria-expanded", String(!collapsed));
  }

  function readSidebarUiState() {
    const host = document.getElementById(SIDEBAR_ID);
    const sidebar = shadowRoot?.querySelector(".resume-pro");
    if (!host || !sidebar) {
      return self.ResumeProSidebarState.normalize(state.sidebarUiState);
    }

    // The host uses position: fixed, so these are viewport coordinates unless a
    // page deliberately establishes a transformed containing block.
    const rect = host.getBoundingClientRect();
    return self.ResumeProSidebarState.normalize({
      collapsed: sidebar.classList.contains("is-collapsed"),
      left: rect.left,
      top: rect.top
    });
  }

  function applySidebarUiState() {
    const host = document.getElementById(SIDEBAR_ID);
    const sidebar = shadowRoot?.querySelector(".resume-pro");
    if (!host || !sidebar) {
      return;
    }

    const uiState = self.ResumeProSidebarState.normalize(state.sidebarUiState);
    sidebar.classList.toggle("is-collapsed", uiState.collapsed);
    updateCollapseButton(sidebar);

    if (uiState.left === null || uiState.top === null) {
      host.style.removeProperty("left");
      host.style.top = `${SIDEBAR_DEFAULT_TOP}px`;
      host.style.right = `${SIDEBAR_DEFAULT_RIGHT}px`;
      state.sidebarUiState = uiState;
      return;
    }

    const rect = host.getBoundingClientRect();
    const constrained = self.ResumeProSidebarState.constrain(
      uiState,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight }
    );
    host.style.left = `${constrained.left}px`;
    host.style.top = `${constrained.top}px`;
    host.style.right = "auto";
    state.sidebarUiState = constrained;
  }

  function constrainSidebarToViewport() {
    const current = self.ResumeProSidebarState.normalize(state.sidebarUiState);
    if (current.left === null || current.top === null) {
      // Keep the untouched default anchored to the right edge as the viewport changes.
      state.sidebarUiState = current;
      applySidebarUiState();
      return false;
    }

    // A resize only pulls the sidebar back into view for this session. It is
    // deliberately not persisted: a window the user shrank for a moment should not
    // overwrite the position they chose on a larger one.
    state.sidebarUiState = readSidebarUiState();
    applySidebarUiState();
    return !self.ResumeProSidebarState.equal(current, state.sidebarUiState);
  }

  function persistSidebarUiState() {
    const previous = self.ResumeProSidebarState.normalize(state.sidebarUiState);
    state.sidebarUiState = readSidebarUiState();
    applySidebarUiState();
    if (self.ResumeProSidebarState.equal(previous, state.sidebarUiState)) {
      return;
    }
    StorageService.setSidebarUiState(state.sidebarUiState).catch(() => {});
  }

  function clamp(value, min, max) {
    return max < min ? 0 : Math.min(Math.max(value, min), max);
  }

  function inferPickerInputType(container, inner) {
    const cls = container.className || "";
    const placeholder = [inner.getAttribute("placeholder"), inner.getAttribute("data-format"), container.getAttribute("data-format")]
      .filter(Boolean).join(" ").toLowerCase();
    if (["date", "month", "datetime-local", "time"].includes(inner.type)) return inner.type;
    if (/datetime/i.test(cls) || /日期.*时间|datetime|yyyy.*dd.*hh/.test(placeholder)) return "datetime-local";
    // “开始时间”“毕业时间”不是时分控件；“年月日”也不能误判成月份。
    if (/年月日|年.*月.*日|yyyy[-/.]mm[-/.]dd/.test(placeholder)) return "date";
    if (/month/i.test(cls) || /年月|月份|month|yyyy[-/.]mm/.test(placeholder)) return "month";
    if (/(?:^|[\s_-])time(?:[\s_-]|$)/i.test(cls) || /hh:mm|时分/.test(placeholder)) return "time";
    return "date";
  }

  function isVisible(element) {
    const styles = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return styles.display !== "none"
      && styles.visibility !== "hidden"
      && rect.width > 0
      && rect.height > 0;
  }

  function normalizeStore(rawState) {
    const templates = Array.isArray(rawState.templates)
      ? rawState.templates
          .map((rawEntry) => {
            const template = normalizeTemplate(rawEntry);

            if (!template) {
              return null;
            }

            // 每份「我的信息」自带一份基础信息，各方向互不干扰。必须从原始条目取 profile：
            // normalizeTemplate 只保留 id/name/groups，取它身上的 profile 永远拿不到，
            // 于是填写时每次都退回全局那份（方向之间串数据）—— 踩过。
            const own = rawEntry && typeof rawEntry.profile === "object" ? rawEntry.profile : null;

            return {
              ...template,
              profile: self.ResumeProProfile
                ? self.ResumeProProfile.normalizeProfile(own || rawState.profile)
                : own || rawState.profile || { values: {}, family: [], custom: [] }
            };
          })
          .filter(Boolean)
      : [];

    const activeTemplateId = typeof rawState.activeTemplateId === "string"
      ? rawState.activeTemplateId
      : "";

    return {
      templates,
      activeTemplateId: templates.some((template) => template.id === activeTemplateId)
        ? activeTemplateId
        : templates[0]?.id || "",
      aiConfig: {
        apiUrl: String(rawState.aiConfig?.apiUrl ?? "https://api.openai.com/v1/chat/completions").trim(),
        model: String(rawState.aiConfig?.model ?? "gpt-4o-mini").trim(),
        apiKey: String(rawState.aiConfig?.apiKey ?? "")
      },
      profile: self.ResumeProProfile
        ? self.ResumeProProfile.normalizeProfile(rawState.profile)
        : { values: {}, family: [], custom: [] }
    };
  }

  function normalizeTemplate(template) {
    if (!template || typeof template !== "object") {
      return null;
    }

    const groups = Array.isArray(template.groups)
      ? template.groups
          .map((group) => {
            if (!group || typeof group !== "object") {
              return null;
            }

            const fields = Array.isArray(group.fields)
              ? group.fields
                  .map((field) => {
                    if (!field || typeof field !== "object") {
                      return null;
                    }

                    return {
                      key: String(field.key ?? "").trim(),
                      value: String(field.value ?? "")
                    };
                  })
                  .filter((field) => field && field.key)
              : [];

            return {
              name: String(group.name ?? "").trim() || "未分类",
              fields
            };
          })
          .filter((group) => group && group.fields.length)
      : [];

    return {
      id: typeof template.id === "string" && template.id.trim() ? template.id : crypto.randomUUID(),
      name: String(template.name ?? "").trim() || "未命名",
      groups
    };
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  // --- Desktop link ---------------------------------------------------------
  //
  // The sidebar reads the page and shows the result; the service worker owns the native
  // messaging port and both queues. Content scripts cannot open that port at all, so every
  // desktop operation is a message.
  //
  // Extraction and URL redaction run here rather than in the worker because the worker has
  // no DOM, and because §5.2 puts the credential stripping before anything leaves the page.

  let desktopModules = null;
  let pendingFields = null;
  // The finished fill the card is offering to archive, and a copy of the template it used.
  // Held only until the user answers; the template copy leaves only if the box is ticked.
  let pendingFill = null;
  let pendingFillTemplate = null;

  async function loadDesktopModules() {
    if (!desktopModules) {
      const [extract, copy, fillrecords, snapshot] = await Promise.all([
        import(chrome.runtime.getURL("link/extract.mjs")),
        import(chrome.runtime.getURL("link/copy.mjs")),
        import(chrome.runtime.getURL("link/fillrecords.mjs")),
        import(chrome.runtime.getURL("link/snapshot.mjs"))
      ]);
      desktopModules = { extract, copy, fillrecords, snapshot };
    }
    return desktopModules;
  }

  function bindDesktopEvents(sidebar) {
    sidebar.querySelector("#resume-pro-save-job")?.addEventListener("click", handleSaveJobClick);
    sidebar.querySelector("#resume-pro-confirm-submit")?.addEventListener("click", handleConfirmSubmitClick);
    sidebar.querySelector("#resume-pro-save-cancel")?.addEventListener("click", closeSaveForm);
    sidebar.querySelector("#resume-pro-fill-record-save")?.addEventListener("click", handleRecordFillClick);
    sidebar.querySelector("#resume-pro-fill-record-skip")?.addEventListener("click", closeFillRecord);
    sidebar.querySelector("#resume-pro-save-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submitSaveForm({ force: false });
    });
    refreshPendingList();
  }

  async function handleSaveJobClick() {
    const form = shadowRoot?.querySelector("#resume-pro-save-form");
    if (!form) return;

    try {
      const { extract } = await loadDesktopModules();
      const fields = extract.extractJobFields(document, location.href);
      form.querySelector("#resume-pro-save-company").value = fields.company;
      form.querySelector("#resume-pro-save-title").value = fields.title;
      form.querySelector("#resume-pro-save-location").value = fields.location;
      form.querySelector("#resume-pro-save-url").value = fields.sourceUrl;
      pendingFields = fields;
      const note = form.querySelector("#resume-pro-save-note");
      // Blanks are expected: nothing is guessed. Saying so is what stops a user from
      // assuming the extension already knows the employer.
      note.textContent = fields.company
        ? "请核对，缺的可以自己补。"
        : "这个页面没有声明公司名，请手动填写；插件不会替你猜。";
      form.hidden = false;
      setDesktopStatus(null);
    } catch (error) {
      setDesktopStatus({ tone: "warn", text: "读取页面信息失败，请手动填写后再保存。" });
    }
  }

  // Confirming a submission is its own act: it has nothing to do with whether the AI fill
  // worked, and nothing to do with having saved the posting a moment ago. The application is
  // chosen from the desktop's own candidates rather than remembered here, so the plugin never
  // holds a stale application id across a restore.
  async function handleConfirmSubmitClick() {
    const { extract, copy } = await loadDesktopModules();
    const fields = extract.extractJobFields(document, location.href);
    if (!fields.company) {
      setDesktopStatus({ tone: 'warn', text: '这个页面看不出是哪家公司，请先在桌面里确认投递。' });
      return;
    }

    let candidates;
    try {
      candidates = await chrome.runtime.sendMessage({ type: "DESKTOP_CANDIDATES_FOR", fields });
    } catch {
      candidates = null;
    }
    if (candidates?.status !== "ok") {
      setDesktopStatus(copy.describeConfirmResult({ status: "pending" }));
      return;
    }

    const options = [...candidates.exact, ...candidates.sameCompany];
    if (!options.length) {
      setDesktopStatus({ tone: 'warn', text: '桌面里还没有这家公司的申请，请先保存岗位。' });
      return;
    }

    const box = shadowRoot?.querySelector("#resume-pro-candidates");
    const list = shadowRoot?.querySelector("#resume-pro-candidate-list");
    shadowRoot.querySelector("#resume-pro-candidates-note").textContent = "这次投递的是哪一条申请？";
    list.textContent = "";
    for (const candidate of options) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "resume-pro__candidate";
      row.textContent = `${candidate.company} · ${candidate.title}`;
      row.addEventListener("click", async () => {
        box.hidden = true;
        const result = await chrome.runtime.sendMessage({
          type: "DESKTOP_CONFIRM_SUBMIT", applicationId: candidate.applicationId
        });
        setDesktopStatus(copy.describeConfirmResult(result ?? { status: "pending" }));
        refreshPendingList();
      });
      list.appendChild(row);
    }
    shadowRoot.querySelector("#resume-pro-bind-new").hidden = true;
    box.hidden = false;
  }

  // --- D08: archiving a finished fill ----------------------------------------------------
  //
  // After every fill the sidebar may offer to archive it. It never blocks the fill and never
  // throws into it, and a profile that has never paired a desktop is not asked at all: those
  // users keep nothing. What is offered is counts and timings; the field values stay here.

  async function offerFillRecord(raw, template) {
    const card = shadowRoot?.querySelector("#resume-pro-fill-record");
    if (!card) return;
    // Read the page before waiting on the worker: on a single-page site the user can move on
    // to the next posting meanwhile, and this fill must not be filed under that one. The
    // modules were warmed when the fill started; if they were not, and the page changed while
    // they loaded, there is no posting to offer this fill under.
    const pageUrl = location.href;
    const { extract, copy, fillrecords, snapshot } = await loadDesktopModules();
    if (location.href !== pageUrl) return;
    const job = extract.extractJobFields(document, pageUrl);
    const link = await chrome.runtime.sendMessage({ type: "DESKTOP_LINK_STATE" });
    if (!link?.everPaired) return;
    // The template the fill actually used, frozen now: editing the template before answering
    // must not change what the snapshot says was used (D08 decision 2).
    pendingFillTemplate = template ? structuredClone(template) : null;
    pendingFill = {
      ...raw,
      urlRedacted: job.sourceUrl,
      templateVersion: (await snapshot.templateVersionOf(template)) || "",
      pluginVersion: chrome.runtime.getManifest().version,
      job: { company: job.company, title: job.title, sourceUrl: job.sourceUrl }
    };
    // The summary is built from exactly what would be sent, so the card cannot promise more.
    card.querySelector("#resume-pro-fill-record-summary").textContent =
      copy.describeFillOffer(fillrecords.buildFillPayload(pendingFill));
    const option = card.querySelector("#resume-pro-fill-record-snapshot");
    if (option) {
      option.checked = true;
      option.disabled = !pendingFillTemplate;
    }
    card.hidden = false;
  }

  function closeFillRecord() {
    const card = shadowRoot?.querySelector("#resume-pro-fill-record");
    if (card) card.hidden = true;
    pendingFill = null;
    pendingFillTemplate = null;
  }

  async function handleRecordFillClick() {
    const raw = pendingFill;
    if (!raw) return;
    const withSnapshot = shadowRoot?.querySelector("#resume-pro-fill-record-snapshot")?.checked;
    const snapshotTemplate = withSnapshot ? pendingFillTemplate : null;
    closeFillRecord();

    let candidates = null;
    if (raw.job?.company) {
      try {
        candidates = await chrome.runtime.sendMessage({ type: "DESKTOP_CANDIDATES_FOR", fields: raw.job });
      } catch {
        candidates = null;
      }
    }
    if (candidates?.status !== "ok") {
      // The desktop is not answering, or the page does not say which company this is. The
      // fill waits, and the application is picked from the pending list later.
      await recordFill(raw, null, snapshotTemplate);
      return;
    }

    const options = [...candidates.exact, ...candidates.sameCompany];
    showFillCandidates(options, {
      note: options.length
        ? "这次填写属于哪条申请？"
        : "桌面里还没有这家公司的申请。可以先「保存岗位到本地」，或者稍后在待同步里选择。",
      onPick: applicationId => recordFill(raw, applicationId, snapshotTemplate),
      onLater: () => recordFill(raw, null, snapshotTemplate)
    });
  }

  async function recordFill(raw, applicationId, snapshotTemplate) {
    const { copy } = await loadDesktopModules();
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "DESKTOP_RECORD_FILL", raw, applicationId, snapshotTemplate });
    } catch {
      result = { status: "rejected" };
    }
    setDesktopStatus(copy.describeFillRecordResult(result ?? { status: "rejected" }));
    revealDesktopStatus();
    refreshPendingList();
  }

  // The card sits under the fill result; the answer lands in the desktop section further
  // down. Bring it into view so the click does not look like it did nothing.
  function revealDesktopStatus() {
    shadowRoot?.querySelector("#resume-pro-desktop-status")?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  // The same candidate box saving a job uses. There is no "new application" here: a fill
  // belongs to an application that exists, and nothing is ever bound on the user's behalf.
  function showFillCandidates(options, { note, onPick, onLater }) {
    const box = shadowRoot?.querySelector("#resume-pro-candidates");
    const list = shadowRoot?.querySelector("#resume-pro-candidate-list");
    if (!box || !list) return;
    shadowRoot.querySelector("#resume-pro-candidates-note").textContent = note;
    list.textContent = "";
    for (const candidate of options) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "resume-pro__candidate";
      row.textContent = `${candidate.company} · ${candidate.title}${candidate.stage ? `（${candidate.stage}）` : ""}`;
      row.addEventListener("click", () => {
        box.hidden = true;
        onPick(candidate.applicationId);
      });
      list.appendChild(row);
    }
    shadowRoot.querySelector("#resume-pro-bind-new").hidden = true;
    shadowRoot.querySelector("#resume-pro-bind-later").onclick = () => {
      box.hidden = true;
      onLater();
    };
    box.hidden = false;
    box.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  // What the desktop shows as an application's id. Checked before binding: a mistyped id would
  // otherwise be queued and then refused on every attempt.
  const APPLICATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // A waiting record, bound from the pending list.
  async function chooseFillApplication(record) {
    const { copy } = await loadDesktopModules();
    if (!record.job?.company) {
      const typed = prompt("这条留档要记到哪条申请？请粘贴桌面里的申请 ID：")?.trim();
      if (!typed) return;
      if (!APPLICATION_ID_PATTERN.test(typed)) {
        setDesktopStatus(copy.describeFillRecordResult({ status: "rejected", reason: "invalid_application_id" }));
        return;
      }
      await bindFillRecord(record.recordId, typed);
      return;
    }
    let candidates;
    try {
      candidates = await chrome.runtime.sendMessage({ type: "DESKTOP_CANDIDATES_FOR", fields: record.job });
    } catch {
      candidates = null;
    }
    if (candidates?.status !== "ok") {
      setDesktopStatus(copy.describeFillRecordResult({ status: "recorded", mode: "unavailable" }));
      return;
    }
    const options = [...candidates.exact, ...candidates.sameCompany];
    showFillCandidates(options, {
      note: options.length ? "这次填写属于哪条申请？" : "桌面里还没有这家公司的申请，请先保存岗位。",
      onPick: applicationId => bindFillRecord(record.recordId, applicationId),
      onLater: () => {}
    });
  }

  async function bindFillRecord(recordId, applicationId) {
    const { copy } = await loadDesktopModules();
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "DESKTOP_BIND_FILL", recordId, applicationId });
    } catch {
      result = { status: "pending" };
    }
    setDesktopStatus(copy.describeFillRecordResult(result ?? { status: "pending" }));
    revealDesktopStatus();
    refreshPendingList();
  }

  function closeSaveForm() {
    const form = shadowRoot?.querySelector("#resume-pro-save-form");
    if (form) form.hidden = true;
    pendingFields = null;
  }

  async function submitSaveForm({ force }) {
    const form = shadowRoot?.querySelector("#resume-pro-save-form");
    if (!form) return;

    const fields = {
      company: form.querySelector("#resume-pro-save-company").value.trim(),
      title: form.querySelector("#resume-pro-save-title").value.trim(),
      location: form.querySelector("#resume-pro-save-location").value.trim(),
      // The URL is whatever redaction produced when the form opened. It is not editable and
      // is never re-read from the address bar here, so no un-redacted URL can reach storage.
      sourceUrl: pendingFields?.sourceUrl || "",
      dedupeUrl: pendingFields?.dedupeUrl || ""
    };

    const { copy } = await loadDesktopModules();
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "DESKTOP_SAVE_JOB", fields, force });
    } catch (error) {
      result = { status: "error" };
    }

    setDesktopStatus(copy.describeSaveResult(result ?? { status: "error" }));
    if (result?.status === "queued") {
      closeSaveForm();
      if (result.mode === "ready") {
        await offerCandidates(result.intent.intentId);
      }
    }
    refreshPendingList();
  }

  // Two layers, per §7. The exact layer is "this may be the same posting again"; the
  // same-company layer is a hint and nothing more. Neither ever binds on its own — the
  // default is always a new application.
  async function offerCandidates(intentId) {
    const box = shadowRoot?.querySelector("#resume-pro-candidates");
    const list = shadowRoot?.querySelector("#resume-pro-candidate-list");
    if (!box || !list) return;

    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "DESKTOP_CANDIDATES", intentId });
    } catch {
      return;
    }
    if (result?.status !== "ok") return;

    list.textContent = "";
    const note = shadowRoot.querySelector("#resume-pro-candidates-note");
    const total = result.exact.length + result.sameCompany.length;
    note.textContent = total
      ? "桌面里有相关的申请。要绑定到已有的哪一条，还是新建？默认新建。"
      : "桌面里没有相关的申请，确认后会新建一条。";

    appendCandidateGroup(list, "可能是同一岗位的重复投递", result.exact, intentId);
    appendCandidateGroup(list, "同公司的其他岗位（仅供参考）", result.sameCompany, intentId);

    box.hidden = false;
    const bindNew = shadowRoot.querySelector("#resume-pro-bind-new");
    bindNew.hidden = false;
    bindNew.onclick = () => bindIntent(intentId, null);
    shadowRoot.querySelector("#resume-pro-bind-later").onclick = () => {
      // §5.2.4: cancelling the picker keeps the intent pending. Nothing is bound and nothing
      // is discarded.
      box.hidden = true;
    };
  }

  function appendCandidateGroup(list, heading, candidates, intentId) {
    if (!candidates.length) return;
    const title = document.createElement("p");
    title.className = "resume-pro__save-note";
    title.textContent = heading;
    list.appendChild(title);

    for (const candidate of candidates) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "resume-pro__candidate";
      row.textContent = `${candidate.company} · ${candidate.title}${candidate.stage ? `（${candidate.stage}）` : ""}`;
      row.addEventListener("click", () => bindIntent(intentId, candidate.applicationId));
      list.appendChild(row);
    }
  }

  async function bindIntent(intentId, applicationId) {
    const { copy } = await loadDesktopModules();
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "DESKTOP_BIND", intentId, applicationId });
    } catch {
      result = { status: "pending" };
    }

    const box = shadowRoot?.querySelector("#resume-pro-candidates");
    if (box) box.hidden = true;
    setDesktopStatus(copy.describeBindResult(result ?? { status: "pending" }));
    refreshPendingList();
  }

  function setDesktopStatus(copy) {
    const box = shadowRoot?.querySelector("#resume-pro-desktop-status");
    if (!box) return;
    box.textContent = "";
    box.className = "resume-pro__desktop-status";
    if (!copy) return;

    box.classList.add(`is-${copy.tone}`);
    const line = document.createElement("p");
    line.textContent = copy.text;
    box.appendChild(line);

    if (copy.extensionId) {
      const id = document.createElement("code");
      id.className = "resume-pro__extension-id";
      id.textContent = copy.extensionId;
      box.appendChild(id);
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "resume-pro__manager-button";
      copyButton.textContent = "复制扩展 ID";
      copyButton.addEventListener("click", () => copyText(copy.extensionId));
      box.appendChild(copyButton);
    }

    if (copy.hint) {
      const hint = document.createElement("p");
      hint.className = "resume-pro__save-note";
      hint.textContent = copy.hint;
      box.appendChild(hint);
    }

    if (copy.offerForce) {
      const again = document.createElement("button");
      again.type = "button";
      again.className = "resume-pro__manager-button";
      again.textContent = "再存一次";
      again.addEventListener("click", () => submitSaveForm({ force: true }));
      box.appendChild(again);
    }
  }

  async function refreshPendingList() {
    const details = shadowRoot?.querySelector("#resume-pro-pending");
    const list = shadowRoot?.querySelector("#resume-pro-pending-list");
    if (!details || !list) return;

    let intents = [];
    let outbox = [];
    let fillRecords = [];
    let expired = new Set();
    let copy;
    try {
      const reply = await chrome.runtime.sendMessage({ type: "DESKTOP_LIST_QUEUE" });
      intents = reply?.intents || [];
      outbox = reply?.outbox || [];
      fillRecords = reply?.fillRecords || [];
      expired = new Set(reply?.expiredSnapshots || []);
      ({ copy } = await loadDesktopModules());
    } catch {
      return;
    }

    const total = intents.length + outbox.length + fillRecords.length;
    details.hidden = total === 0;
    shadowRoot.querySelector("#resume-pro-pending-count").textContent = String(total);
    list.textContent = "";

    for (const intent of intents) {
      const row = pendingRow(
        `${intent.fields.company} · ${intent.fields.title}`,
        intent.fields.sourceUrl,
        intent.status === "pending_bind" ? "待绑定申请" : "待同步（尚未绑定申请）"
      );
      if (intent.status === "pending_bind") {
        row.appendChild(rowButton("选择绑定", () => offerCandidates(intent.intentId)));
      }
      row.appendChild(rowButton("删除", async () => {
        await chrome.runtime.sendMessage({ type: "DESKTOP_REMOVE_INTENT", intentId: intent.intentId });
        refreshPendingList();
      }));
      list.appendChild(row);
    }

    for (const record of fillRecords) {
      const row = pendingRow(
        `填写留档 · ${record.fill?.templateName || ""}`,
        [record.job?.company, record.job?.title].filter(Boolean).join(" · "),
        "待同步（尚未选择申请）"
      );
      if (record.snapshot && expired.has(record.snapshot.snapshotId)) {
        appendNote(row, "附带的简历快照已暂存超过 30 天，要继续还是丢弃？");
        row.appendChild(rowButton("丢弃快照", () => dropSnapshot(record.snapshot.snapshotId)));
      }
      row.appendChild(rowButton("选择申请", () => chooseFillApplication(record)));
      row.appendChild(rowButton("删除", async () => {
        await chrome.runtime.sendMessage({ type: "DESKTOP_REMOVE_FILL", recordId: record.recordId });
        refreshPendingList();
      }));
      list.appendChild(row);
    }

    for (const entry of outbox.filter(item => item.messageType === "snapshot.upload")) {
      const state = copy.describeSnapshotUpload(entry, { expired: expired.has(entry.snapshotId) });
      const row = pendingRow(`简历快照 · ${entry.payload?.templateName || ""}`, "", state.text);
      if (entry.status === "paused" || entry.status === "needs_user") {
        // After a restore the only ways out are the user's: upload the kept original again
        // under a new identity, or let it go. Never a plain retry of the old chunks.
        appendNote(row, copy.describeSnapshotReconcile(entry.reconcileStatus).text);
        row.appendChild(rowButton("重新上传到当前档案", () => resolvePaused(entry, "resave")));
        row.appendChild(rowButton("丢弃快照", () => resolvePaused(entry, "discard")));
        list.appendChild(row);
        continue;
      }
      if (state.retry) {
        row.appendChild(rowButton("立即重试", async () => {
          await chrome.runtime.sendMessage({ type: "DESKTOP_RETRY", messageId: entry.messageId });
          refreshPendingList();
        }));
      }
      row.appendChild(rowButton(entry.status === "bytes_lost" ? "移除" : "丢弃快照", () => dropSnapshot(entry.snapshotId)));
      list.appendChild(row);
    }

    for (const entry of outbox.filter(item => item.messageType !== "snapshot.upload")) {
      const row = pendingRow(queueLabel(entry), entry.payload?.sourceUrl, describeOutboxState(entry));
      if (entry.status === "needs_user" || entry.status === "paused") {
        appendReconcileChoices(row, entry);
        list.appendChild(row);
        continue;
      }
      row.appendChild(rowButton("立即重试", async () => {
        const { copy } = await loadDesktopModules();
        const result = await chrome.runtime.sendMessage({ type: "DESKTOP_RETRY", messageId: entry.messageId });
        setDesktopStatus(describeQueueResult(copy, entry, result ?? { status: "pending" }));
        refreshPendingList();
      }));
      row.appendChild(rowButton("取消", async () => {
        await chrome.runtime.sendMessage({ type: "DESKTOP_CANCEL", messageId: entry.messageId });
        refreshPendingList();
      }));
      list.appendChild(row);
    }
  }

  function appendNote(row, text) {
    const note = document.createElement("em");
    note.textContent = text;
    row.appendChild(note);
  }

  // The fill record stays; only the snapshot copy and its upload go.
  async function dropSnapshot(snapshotId) {
    await chrome.runtime.sendMessage({ type: "DESKTOP_DROP_SNAPSHOT", snapshotId });
    refreshPendingList();
  }

  // Each kind of queued message has its own wording: a retried fill must not report that a
  // job was saved, nor a refused one ask the user to check a company name.
  function describeQueueResult(copy, entry, result) {
    if (entry.messageType === "fill.submit") return copy.describeFillRecordResult(result);
    if (entry.messageType === "snapshot.upload") return copy.describeSnapshotResolveResult(result);
    if (entry.messageType === "submit.confirm") return copy.describeConfirmResult(result);
    return copy.describeBindResult(result);
  }

  function queueLabel(entry) {
    if (entry.messageType === "fill.submit") return `填写留档 · ${entry.payload?.templateName || ""}`;
    if (entry.messageType === "submit.confirm") return "确认已投递";
    return `${entry.payload?.company || ""} · ${entry.payload?.title || ""}`;
  }

  function pendingRow(label, title, state) {
    const row = document.createElement("div");
    row.className = "resume-pro__pending-row";

    const name = document.createElement("span");
    name.textContent = label;
    name.title = title || "";
    row.appendChild(name);

    const status = document.createElement("em");
    status.textContent = state;
    row.appendChild(status);
    return row;
  }

  function rowButton(text, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "resume-pro__manager-button";
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  // After a restore the queued envelope carries an epoch the desktop has replaced. There is
  // no "retry" here on purpose: the only ways out are the three the user chooses.
  function appendReconcileChoices(row, entry) {
    loadDesktopModules().then(({ copy }) => {
      const explain = copy.describeReconcileStatus(entry.reconcileStatus);
      const note = document.createElement("em");
      note.textContent = explain.text;
      row.appendChild(note);
    });

    row.appendChild(rowButton("关联到已有申请", async () => {
      const applicationId = prompt("要关联到哪条申请？请粘贴桌面里的申请 ID：");
      if (!applicationId) return;
      await resolvePaused(entry, "associate", applicationId.trim());
    }));
    row.appendChild(rowButton("另存为新的", () => resolvePaused(entry, "resave")));
    row.appendChild(rowButton("丢弃", () => resolvePaused(entry, "discard")));
  }

  async function resolvePaused(entry, choice, applicationId) {
    const { copy } = await loadDesktopModules();
    const result = await chrome.runtime.sendMessage({
      type: "DESKTOP_RESOLVE", messageId: entry.messageId, choice, applicationId
    });
    if (choice !== "discard") {
      // A resaved snapshot is queued, not yet on the desktop: described as pending.
      const shown = result?.status === "queued" ? { status: "pending" } : (result ?? { status: "pending" });
      setDesktopStatus(describeQueueResult(copy, entry, shown));
    }
    refreshPendingList();
  }

  // The reason is the plugin's own classification, not the protocol text: the wording table
  // in link/copy.mjs is the only place that turns a code into a sentence.
  function describeOutboxState(entry) {
    if (entry.status === "paused") return "桌面换过档案库，已暂停";
    if (entry.status === "needs_user") return "桌面换过档案库，等你决定";
    if (entry.status === "failed") return `已停下，需要处理（${describeFailure(entry.lastError)}）`;
    if (entry.status === "stalled") return `重试多次仍未成功，等你决定（${describeFailure(entry.lastError)}）`;
    const next = entry.nextAttemptAt ? `，下次重试 ${formatClock(entry.nextAttemptAt)}` : "";
    return `待同步（已尝试 ${entry.attempts || 0} 次${next}）`;
  }

  function describeFailure(code) {
    if (code === "unavailable") return "桌面暂时不可用";
    if (code === "invalid_payload") return "桌面看不懂这条内容";
    if (code === "restore_epoch_mismatch") return "桌面换过档案库";
    if (code === "previously_purged") return "已在桌面永久删除";
    if (code === "conflict") return "与桌面已有记录冲突";
    return "原因未知";
  }

  function formatClock(iso) {
    const at = new Date(iso);
    return Number.isNaN(at.getTime())
      ? "稍后"
      : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  if (self.__RESUME_PRO_TEST__) {
    self.ResumeProHighlightTest = {
      applySidebarUiState,
      bindStorageSync,
      constrainSidebarToViewport,
      persistSidebarUiState,
      readSidebarUiState,
      stopDrag,
      handleRepeatFillClick,
      formatFillDiagnostics,
      getHighlightTargets,
      handleAiFillClick,
      handleChipAction,
      handleFieldChipClick,
      highlightFilledField,
      injectFieldHighlightStyles,
      shakeField,
      isInViewport,
      applyChipValue,
      composeChipText,
      syncChipSelectionState,
      setCurrentStore(store) {
        state.currentStore = store;
      },
      setLastFocusedField(field) {
        state.lastFocusedField = field;
      },
      setDragging(dragging) {
        state.dragging = Boolean(dragging);
      },
      setSidebarUiState(uiState) {
        state.sidebarUiState = self.ResumeProSidebarState.normalize(uiState);
      },
      getSidebarUiState() {
        return self.ResumeProSidebarState.normalize(state.sidebarUiState);
      },
      setShadowRoot(root) {
        shadowRoot = root;
      }
    };
  }
})();
