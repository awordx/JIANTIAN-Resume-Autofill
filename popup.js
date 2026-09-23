const DEFAULT_STORE = {
  templates: [],
  activeTemplateId: "",
  aiConfig: {
    apiUrl: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    apiKey: ""
  },
  profile: {
    values: {},
    education: [],
    family: [],
    custom: []
  }
};

const UPDATE_API_URL = "https://api.github.com/repos/awordx/JIANXING-Resume-Autofill/releases/latest";
const UPDATE_CACHE_KEY = "resumeProUpdateCache";
const UPDATE_DISMISSED_KEY = "resumeProDismissedVersion";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_FAILURE_RETRY_MS = 60 * 60 * 1000;
const MAX_LISTED_ROW_NUMBERS = 20;
const TEMPLATE_SHEET_HEADER = ["一级分类", "字段名", "值"];
const BACKUP_FORMAT = "resume-pro.backup";
// 2 起备份里可以带「基础信息」（结构化档案）。只有我的信息（原叫模板）的备份仍写 1，旧版插件照样能导入；
// 带了档案的写 2，旧版插件会提示先更新，而不是悄悄丢掉档案。
const BACKUP_FORMAT_VERSION = 2;
let pdfJsPromise = null;

const STORE_KEYS = Object.keys(DEFAULT_STORE);

// 设置页、侧边栏、别的标签页都会读写同一份 storage。读到快照再整份写回，中间别人刚存的
// 东西就会被旧快照盖掉，所以这里只写真正变了的键。
const StorageService = {
  async ensureDefaults() {
    const current = await chrome.storage.local.get(STORE_KEYS);
    const missing = {};

    for (const key of STORE_KEYS) {
      if (current[key] === undefined) {
        missing[key] = structuredClone(DEFAULT_STORE[key]);
      }
    }

    if (Object.keys(missing).length) {
      await chrome.storage.local.set(missing);
    }

    return normalizeStore({ ...current, ...missing });
  },

  async getState() {
    const current = await chrome.storage.local.get(STORE_KEYS);
    return normalizeStore(current);
  },

  async ensureProfileRecord() {
    const current = await this.getState();
    const api = self.ResumeProProfile;
    if (current.templates.length || !api.hasProfileContent(current.profile)) return current;
    return this.update((draft) => {
      if (draft.templates.length || !api.hasProfileContent(draft.profile)) return draft;
      const entry = {
        id: crypto.randomUUID(),
        name: String(draft.profile.values?.name || "").trim() || "新建信息",
        groups: [],
        profile: structuredClone(draft.profile)
      };
      draft.templates.push(entry);
      draft.activeTemplateId = entry.id;
      return draft;
    });
  },

  // 整份替换，只给备份恢复这种本来就要覆盖全部的场景用。
  async saveState(nextState) {
    const normalized = normalizeStore(nextState);
    await chrome.storage.local.set(normalized);
    return normalized;
  },

  async update(updater) {
    const current = await this.getState();
    const next = normalizeStore(await updater(structuredClone(current)));
    const changed = {};

    for (const key of STORE_KEYS) {
      if (JSON.stringify(next[key]) !== JSON.stringify(current[key])) {
        changed[key] = next[key];
      }
    }

    if (Object.keys(changed).length) {
      await chrome.storage.local.set(changed);
    }

    return next;
  },

  async setActiveTemplate(templateId) {
    return this.update((state) => {
      state.activeTemplateId = templateId;
      return state;
    });
  },

  async saveAiConfig(aiConfig) {
    return this.update((state) => {
      state.aiConfig = normalizeAiConfig(aiConfig);
      return state;
    });
  }
};

const popupState = {
  activeTab: "templates",
  availableRelease: null,
  reimportTemplateId: "",
  pendingBackup: null,
  // 解析完成但还没决定「新建 / 更新当前」的结果，等用户点按钮再落盘。
  pendingParsed: null,
  // 正在改名的那一份的 id（内联改名输入行用）。
  renamingId: "",
  // 基础信息页正在编辑的那一份的 id。
  editingEntryId: "",
  modelRequestId: 0,
  modelResult: null,
  modelVisible: [],
  modelActiveIndex: -1,
  profileDirty: false,
  profileIndexObserver: null,
  profileRowSeq: 0,
  statusTimers: {
    profile: null,
    template: null,
    backup: null,
    config: null,
    model: null,
    url: null
  }
};

const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  bootstrap().catch((error) => {
    console.error("Resume Pro popup init failed:", error);
    showStatus("template", `初始化失败：${error.message}`, "error", 0);
  });
});

async function bootstrap() {
  cacheElements();
  bindEvents();
  applyTabFromHash();
  await StorageService.ensureDefaults();
  await StorageService.ensureProfileRecord();
  await render();
  initializeUpdateFeature().catch((error) => {
    console.warn("Resume Pro update feature init failed:", error);
  });
}

function cacheElements() {
  elements.tabButtons = Array.from(document.querySelectorAll(".tab-button"));
  elements.tabPanels = Array.from(document.querySelectorAll(".tab-panel"));
  elements.templateList = document.getElementById("template-list");
  elements.templateFileInput = document.getElementById("template-file-input");
  elements.importTemplateButton = document.getElementById("import-template-button");
  elements.parseToggleButton = document.getElementById("parse-toggle-button");
  elements.parseSection = document.getElementById("parse-section");
  elements.templateStatus = document.getElementById("template-status");
  elements.backupStatus = document.getElementById("backup-status");
  elements.exportBackupButton = document.getElementById("export-backup-button");
  elements.importBackupButton = document.getElementById("import-backup-button");
  elements.backupFileInput = document.getElementById("backup-file-input");
  elements.backupIncludeKey = document.getElementById("backup-include-key");
  elements.backupKeyConfirm = document.getElementById("backup-key-confirm");
  elements.backupKeyConfirmButton = document.getElementById("backup-key-confirm-button");
  elements.backupKeyCancelButton = document.getElementById("backup-key-cancel-button");
  elements.backupConfirm = document.getElementById("backup-confirm");
  elements.backupConfirmText = document.getElementById("backup-confirm-text");
  elements.backupAppendButton = document.getElementById("backup-append-button");
  elements.backupReplaceButton = document.getElementById("backup-replace-button");
  elements.backupCancelButton = document.getElementById("backup-cancel-button");
  elements.profileDirectionSelect = document.getElementById("profile-direction-select");
  elements.profileRenameEntry = document.getElementById("profile-rename-entry");
  elements.profileRenameConfirm = document.getElementById("profile-rename-confirm");
  elements.profileRenameInput = document.getElementById("profile-rename-input");
  elements.profileRenameSaveButton = document.getElementById("profile-rename-save-button");
  elements.profileRenameCancelButton = document.getElementById("profile-rename-cancel-button");
  elements.profileCopyEntry = document.getElementById("profile-copy-entry");
  elements.profileAddEntry = document.getElementById("profile-add-entry");
  elements.profileScopeNote = document.getElementById("profile-scope-note");
  elements.renameConfirm = document.getElementById("rename-confirm");
  elements.renameHint = document.getElementById("rename-hint");
  elements.renameInput = document.getElementById("rename-input");
  elements.renameSaveButton = document.getElementById("rename-save-button");
  elements.renameCancelButton = document.getElementById("rename-cancel-button");
  elements.aiConfigForm = document.getElementById("ai-config-form");
  elements.apiUrlInput = document.getElementById("api-url-input");
  elements.modelInput = document.getElementById("model-input");
  elements.apiKeyInput = document.getElementById("api-key-input");
  elements.toggleApiKeyButton = document.getElementById("toggle-api-key");
  elements.fetchModelsButton = document.getElementById("fetch-models-button");
  elements.modelCombo = document.getElementById("model-combo");
  elements.modelToggle = document.getElementById("model-toggle");
  elements.modelListbox = document.getElementById("model-listbox");
  elements.modelStatus = document.getElementById("model-status");
  elements.urlStatus = document.getElementById("url-status");
  elements.configStatus = document.getElementById("config-status");
  elements.profileForm = document.getElementById("profile-form");
  elements.profilePreset = document.getElementById("profile-preset");
  elements.profileIndex = document.getElementById("profile-index");
  elements.profileEducation = document.getElementById("profile-education");
  elements.profileFamily = document.getElementById("profile-family");
  elements.profileExtraGroups = document.getElementById("profile-extra-groups");
  elements.profileCustom = document.getElementById("profile-custom");
  elements.profileAddMember = document.getElementById("profile-add-member");
  elements.profileAddEducation = document.getElementById("profile-add-education");
  elements.profileAddCustom = document.getElementById("profile-add-custom");
  elements.profileStatus = document.getElementById("profile-status");
  elements.currentVersion = document.getElementById("current-version");
  elements.checkUpdateButton = document.getElementById("check-update-button");
  elements.updateCheckStatus = document.getElementById("update-check-status");
  elements.updateBanner = document.getElementById("update-banner");
  elements.updateTitle = document.getElementById("update-title");
  elements.updateSummary = document.getElementById("update-summary");
  elements.downloadUpdateButton = document.getElementById("download-update-button");
  elements.dismissUpdateButton = document.getElementById("dismiss-update-button");
}

function bindEvents() {
  elements.tabButtons.forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tab));
  });

  elements.parseToggleButton.addEventListener("click", () => {
    const isOpen = elements.parseSection.classList.toggle("is-open");
    elements.parseToggleButton.classList.toggle("is-active", isOpen);
  });

  elements.importTemplateButton.addEventListener("click", () => {
    popupState.reimportTemplateId = "";
    elements.templateFileInput.click();
  });

  elements.templateFileInput.addEventListener("change", handleFileSelection);
  elements.exportBackupButton.addEventListener("click", handleExportBackup);
  elements.backupKeyConfirmButton.addEventListener("click", () => exportBackup(true));
  elements.backupKeyCancelButton.addEventListener("click", hideKeyConfirm);
  elements.backupIncludeKey.addEventListener("change", hideKeyConfirm);
  elements.importBackupButton.addEventListener("click", () => {
    hideBackupConfirm();
    hideKeyConfirm();
    elements.backupFileInput.click();
  });
  elements.backupFileInput.addEventListener("change", handleBackupFileSelection);
  elements.backupAppendButton.addEventListener("click", () => commitPendingBackup("append"));
  elements.backupReplaceButton.addEventListener("click", () => commitPendingBackup("replace"));
  elements.backupCancelButton.addEventListener("click", () => {
    hideBackupConfirm();
    hideStatus("backup");
  });
  elements.templateList.addEventListener("click", handleTemplateListClick);
  elements.profileDirectionSelect?.addEventListener("change", handleProfileDirectionChange);
  elements.profileRenameEntry?.addEventListener("click", showProfileRenameEditor);
  elements.profileRenameSaveButton?.addEventListener("click", commitProfileRename);
  elements.profileRenameCancelButton?.addEventListener("click", hideProfileRenameEditor);
  elements.profileCopyEntry?.addEventListener("click", () => createNewEntry("copy"));
  elements.profileAddEntry?.addEventListener("click", () => createNewEntry("empty"));
  elements.renameSaveButton?.addEventListener("click", commitRename);
  elements.renameCancelButton?.addEventListener("click", hideRenameRow);
  elements.renameInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
    }
    if (event.key === "Escape") {
      hideRenameRow();
    }
  });
  elements.aiConfigForm.addEventListener("submit", handleConfigSubmit);
  elements.profileForm.addEventListener("submit", handleProfileSubmit);
  elements.profileForm.addEventListener("input", markProfileDirty);
  elements.profileForm.addEventListener("change", markProfileDirty);
  elements.profileForm.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-add-extra-group]");
    if (!button) return;
    const schema = self.ResumeProProfile.EXTRA_GROUP_SCHEMAS.find((item) => item.id === button.dataset.addExtraGroup);
    const container = button.previousElementSibling;
    if (schema && container) container.insertAdjacentHTML("beforeend", extraRowHtml(schema, {}));
    markProfileDirty();
  });
  elements.profileForm.addEventListener("click", handleProfileRemoveClick);
  elements.profileIndex?.addEventListener("click", handleProfileIndexClick);
  elements.profileAddEducation.addEventListener("click", () => {
    elements.profileEducation.insertAdjacentHTML("beforeend", educationRowHtml({}));
    markProfileDirty();
  });
  elements.profileAddMember.addEventListener("click", () => {
    elements.profileFamily.insertAdjacentHTML("beforeend", familyRowHtml({ relation: "父亲" }));
    markProfileDirty();
  });
  elements.profileAddCustom.addEventListener("click", () => {
    elements.profileCustom.insertAdjacentHTML("beforeend", customRowHtml({ key: "", value: "" }));
    markProfileDirty();
  });
  // 侧边栏把空字段加进来之后，会带着 #profile 打开管理面板。
  self.addEventListener?.("hashchange", applyTabFromHash);
  elements.toggleApiKeyButton.addEventListener("click", toggleApiKeyVisibility);
  elements.fetchModelsButton.addEventListener("click", handleFetchModelsClick);
  bindModelCombo();
  // Suggestions fetched for one address and key are wrong for another.
  elements.apiUrlInput.addEventListener("input", clearModelSuggestions);
  elements.apiUrlInput.addEventListener("input", updateUrlWarning);
  elements.apiKeyInput.addEventListener("input", clearModelSuggestions);
  elements.checkUpdateButton.addEventListener("click", () => {
    checkForUpdates({ force: true, announce: true });
  });
  elements.downloadUpdateButton.addEventListener("click", openAvailableRelease);
  elements.dismissUpdateButton.addEventListener("click", dismissAvailableRelease);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    // 正在改的表单不重画，否则没保存的输入会被冲掉；提醒一句保存会覆盖别处的改动。
    if (changes.profile && popupState.profileDirty) {
      showStatus("profile", "「我的信息」在别处被改过了，现在保存会覆盖那边的修改。", "warning", 0);
    }

    if (changes.templates || changes.activeTemplateId || changes.aiConfig || changes.profile) {
      render().catch((error) => {
        console.error("Resume Pro popup render failed:", error);
      });
    }
  });
}

function setActiveTab(tabName) {
  popupState.activeTab = tabName;

  elements.tabButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === tabName);
  });

  elements.tabPanels.forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.panel === tabName);
  });
}

async function render() {
  const state = await StorageService.getState();
  renderTemplates(state);
  renderConfig(state.aiConfig);
  if (!popupState.profileDirty) renderProfile(self.ResumeProProfile.entryProfile(state), state);
  setActiveTab(popupState.activeTab);
}

function renderTemplates(state) {
  const { templates, activeTemplateId } = state;

  if (!templates.length) {
    elements.templateList.innerHTML = `
      <div class="empty-state">
        <p>还没有我的信息。</p>
        <p>可以在「基础信息」页点击「添加新信息」直接建立一份空档案，也可以导入 Excel 或用 AI 解析简历。</p>
      </div>
    `;
    return;
  }

  elements.templateList.innerHTML = templates.map((template) => {
    const fieldCount = countTemplateFields(template);
    const groupCount = Array.isArray(template.groups) ? template.groups.length : 0;
    const isActive = template.id === activeTemplateId;

    return `
      <article class="template-item ${isActive ? "is-active" : ""}" data-template-id="${escapeHtml(template.id)}">
        <div class="template-head">
          <div class="template-info">
            <h3 class="template-name">${escapeHtml(template.name || "未命名")}</h3>
            <p class="template-meta">${groupCount} 个分组 · ${fieldCount} 个字段</p>
          </div>
          ${isActive ? '<span class="active-badge">当前使用中</span>' : ""}
        </div>
        <div class="template-actions">
          ${
            isActive
              ? ""
              : '<button class="secondary-button" type="button" data-action="activate">设为当前</button>'
          }
          <button class="secondary-button" type="button" data-action="rename">重命名</button>
          <button class="secondary-button" type="button" data-action="reimport">重新导入 Excel</button>
          <button class="secondary-button" type="button" data-action="export">导出 Excel</button>
          <button class="danger-button" type="button" data-action="delete">删除</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderConfig(aiConfig) {
  elements.apiUrlInput.value = aiConfig.apiUrl || "";
  elements.modelInput.value = aiConfig.model || "";
  elements.apiKeyInput.value = aiConfig.apiKey || "";
  updateUrlWarning();
}

// Shown whenever the settings page shows the address -- on open, while typing and after
// save -- so users already configured with plain http see it too. Nothing is blocked.
function updateUrlWarning() {
  const risk = self.ResumeProModels.describeTransportRisk(elements.apiUrlInput.value);

  if (risk) {
    showStatus("url", risk.message, "warning", 0);
  } else {
    hideStatus("url");
  }
}

async function handleTemplateListClick(event) {
  const actionButton = event.target.closest("button[data-action]");
  const templateCard = event.target.closest(".template-item");

  if (!templateCard) {
    return;
  }

  const templateId = templateCard.dataset.templateId;
  const action = actionButton?.dataset.action;

  if (!action && !actionButton) {
    await StorageService.setActiveTemplate(templateId);
    showStatus("template", "已切换当前使用的我的信息。", "success");
    return;
  }

  if (action === "activate") {
    await StorageService.setActiveTemplate(templateId);
    showStatus("template", "已切换当前使用的我的信息。", "success");
    return;
  }

  if (action === "rename") {
    const state = await StorageService.getState();
    const target = state.templates.find((item) => item.id === templateId);

    if (!target) {
      showStatus("template", "这份我的信息不存在。", "error", 0);
      return;
    }

    showRenameRow(templateId, target.name || "");
    return;
  }

  if (action === "reimport") {
    popupState.reimportTemplateId = templateId;
    elements.templateFileInput.click();
    return;
  }

  if (action === "export") {
    await exportTemplateToExcel(templateId);
    return;
  }

  if (action === "delete") {
    await deleteTemplate(templateId);
  }
}

// 改名只是为了让人一眼看出这是投哪个方向的（「硬件方向」「软件方向」），所以用内联输入，
// 不弹原生 prompt：整个管理面板都是内联确认的写法。
function showRenameRow(templateId, currentName) {
  popupState.renamingId = templateId;

  if (elements.renameHint) {
    elements.renameHint.textContent = `给「${currentName || "未命名"}」改个名字（比如「硬件方向」）：`;
  }

  if (elements.renameInput) {
    elements.renameInput.value = currentName || "";
  }

  if (elements.renameConfirm) {
    elements.renameConfirm.hidden = false;
  }

  elements.renameInput?.focus?.();
  elements.renameInput?.select?.();
}

function hideRenameRow() {
  popupState.renamingId = "";
  if (elements.renameConfirm) {
    elements.renameConfirm.hidden = true;
  }
}

async function commitRename() {
  const templateId = popupState.renamingId;
  const name = String(elements.renameInput?.value || "").trim();

  if (!templateId) {
    return;
  }

  if (!name) {
    showStatus("template", "名字不能为空。", "error", 0);
    return;
  }

  let renamed = null;
  await StorageService.update((draft) => {
    const target = draft.templates.find((item) => item.id === templateId);
    if (target) {
      target.name = name;
      renamed = target;
    }
    return draft;
  });

  hideRenameRow();

  if (!renamed) {
    showStatus("template", "这份我的信息不存在。", "error", 0);
    return;
  }

  showStatus("template", `已改名为「${name}」。`, "success");
}

async function handleFileSelection(event) {
  const [file] = event.target.files || [];
  elements.templateFileInput.value = "";

  const reimportTemplateId = popupState.reimportTemplateId;
  popupState.reimportTemplateId = "";

  if (!file) {
    return;
  }

  try {
    const groups = await parseTemplateFile(file);
    const templateName = getTemplateNameFromFile(file.name);
    const fieldCount = countTemplateFields({ groups });
    let previousFieldCount = null;

    await StorageService.update((state) => {
      if (reimportTemplateId) {
        const target = state.templates.find((item) => item.id === reimportTemplateId);

        if (!target) {
          throw new Error("要重新导入的这份我的信息不存在。");
        }

        previousFieldCount = countTemplateFields(target);
        target.groups = groups;
        state.activeTemplateId = target.id;
      } else {
        const nextTemplate = {
          id: crypto.randomUUID(),
          name: resolveTemplateName(templateName, state.templates),
          groups,
          // 新一份继承当前那份的基础信息（结构一样，值也从当前这份拷）。
          profile: self.ResumeProProfile.entryProfile(state)
        };

        state.templates.unshift(nextTemplate);
        state.activeTemplateId = nextTemplate.id;
      }

      return state;
    });

    const unchanged = previousFieldCount === fieldCount;

    showStatus(
      "template",
      buildImportSuccessMessage(fieldCount, previousFieldCount),
      unchanged ? "warning" : "success",
      unchanged ? 0 : 6000
    );
  } catch (error) {
    const hint = reimportTemplateId ? "本次导入未生效，原来那份保持不变。" : "本次导入未生效。";
    showStatus("template", `导入失败：${error.message}${hint}`, "error", 0);
  }
}

// The count is the only thing a user can check at a glance after editing the Excel by hand,
// so say it out loud — and say it twice when nothing moved, because that almost always means
// the file that got picked is not the file that got edited.
function buildImportSuccessMessage(fieldCount, previousFieldCount) {
  if (previousFieldCount === null) {
    return `已存成一份我的信息，共 ${fieldCount} 个字段。`;
  }

  if (previousFieldCount === fieldCount) {
    return `已覆盖当前这份，仍是 ${fieldCount} 个字段，数量没有变化。如果刚在 Excel 里加过内容，请确认选中的是改完并保存后的那份文件。`;
  }

  return `已覆盖当前这份，字段 ${previousFieldCount} → ${fieldCount} 个。`;
}

function resolveTemplateName(templateName, templates) {
  const usedNames = new Set(templates.map((template) => template.name));

  if (!usedNames.has(templateName)) {
    return templateName;
  }

  let index = 2;

  while (usedNames.has(`${templateName} (${index})`)) {
    index += 1;
  }

  return `${templateName} (${index})`;
}

async function handleConfigSubmit(event) {
  event.preventDefault();

  const typedUrl = elements.apiUrlInput.value.trim() || DEFAULT_STORE.aiConfig.apiUrl;
  const { aiConfig: savedConfig } = await StorageService.getState();
  const aiConfig = {
    apiUrl: self.ResumeProModels.normalizeApiUrlForSave(typedUrl, savedConfig.apiUrl),
    model: elements.modelInput.value.trim() || DEFAULT_STORE.aiConfig.model,
    apiKey: elements.apiKeyInput.value.trim()
  };

  await StorageService.saveAiConfig(aiConfig);

  if (aiConfig.apiUrl !== typedUrl) {
    elements.apiUrlInput.value = aiConfig.apiUrl;
    showStatus("config", `配置已保存。API URL 已补全为 ${aiConfig.apiUrl}`, "success", 6000);
    return;
  }

  showStatus("config", "配置已保存。", "success");
}

// Fetching never touches the model input or storage: the list only feeds the suggestion
// dropdown, so a failed fetch leaves the field behaving exactly like the plain text box it was.
async function handleFetchModelsClick() {
  const button = elements.fetchModelsButton;
  const requestId = ++popupState.modelRequestId;
  button.disabled = true;
  button.textContent = "获取中…";
  showStatus("model", "正在获取模型列表…", "success", 0);

  try {
    const result = await self.ResumeProModels.fetchModelList({
      apiUrl: elements.apiUrlInput.value.trim() || DEFAULT_STORE.aiConfig.apiUrl,
      apiKey: elements.apiKeyInput.value
    });

    if (requestId !== popupState.modelRequestId) {
      return;
    }

    if (!result.ok) {
      setModelSuggestions(null);
      showStatus("model", result.message, "error", 0);
      return;
    }

    setModelSuggestions(result);
    showModelNotice();

    if (result.models.length) {
      elements.modelInput.focus();
      openModelList("");
    }
  } finally {
    button.disabled = false;
    button.textContent = "获取模型";
  }
}

function showModelNotice() {
  const result = popupState.modelResult;

  if (!result) {
    return;
  }

  if (!result.allModels.length) {
    showStatus("model", "该服务返回了空的模型列表，可直接手填模型名称。", "warning", 0);
    return;
  }

  const hiddenNote = result.hiddenCount ? `（另隐藏 ${result.hiddenCount} 个向量、语音、图像等非对话模型）` : "";
  const summary = `已获取 ${result.models.length} 个模型${hiddenNote}。可从列表选择，也可直接输入任意名称。`;
  const currentModel = elements.modelInput.value.trim();

  if (currentModel && !result.allModels.includes(currentModel)) {
    showStatus("model", `${summary}当前填写的「${currentModel}」不在列表中，请确认拼写。`, "warning", 0);
    return;
  }

  showStatus("model", summary, "success", 0);
}

function clearModelSuggestions() {
  popupState.modelRequestId += 1;
  setModelSuggestions(null);
  hideStatus("model");
}

function setModelSuggestions(result) {
  popupState.modelResult = result;
  elements.modelToggle.hidden = !result?.models.length;
  closeModelList();
}

// The suggestion list is a hand-built combobox rather than a <datalist>: Chrome filters a
// datalist by the text already in the box, so a filled-in field would show one option, or
// none when the current name is misspelt -- exactly when the user wants to browse.
function openModelList(query) {
  const suggestions = popupState.modelResult?.models || [];

  if (!suggestions.length) {
    return;
  }

  popupState.modelVisible = self.ResumeProModels.matchModels(suggestions, query);
  popupState.modelActiveIndex = -1;
  renderModelList();
  elements.modelListbox.hidden = false;
  elements.modelInput.setAttribute("aria-expanded", "true");
  placeModelList();
  elements.modelListbox.querySelector(".is-current")?.scrollIntoView({ block: "nearest" });
}

function closeModelList() {
  popupState.modelActiveIndex = -1;
  elements.modelListbox.hidden = true;
  elements.modelInput.setAttribute("aria-expanded", "false");
  elements.modelInput.removeAttribute("aria-activedescendant");
}

function isModelListOpen() {
  return !elements.modelListbox.hidden;
}

function renderModelList() {
  const { modelVisible: visible, modelActiveIndex: active } = popupState;
  const current = elements.modelInput.value.trim();

  if (!visible.length) {
    const empty = document.createElement("li");
    empty.className = "model-combo__empty";
    empty.setAttribute("role", "presentation");
    empty.textContent = "没有匹配的模型，保存时按输入的名称使用。";
    elements.modelListbox.replaceChildren(empty);
    elements.modelInput.removeAttribute("aria-activedescendant");
    return;
  }

  elements.modelListbox.replaceChildren(...visible.map((id, index) => {
    const option = document.createElement("li");
    option.id = `model-option-${index}`;
    option.className = "model-combo__option";
    option.classList.toggle("is-active", index === active);
    option.classList.toggle("is-current", id === current);
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(id === current));
    option.dataset.value = id;
    option.title = id;
    option.textContent = id;
    return option;
  }));

  if (active >= 0) {
    elements.modelInput.setAttribute("aria-activedescendant", `model-option-${active}`);
    document.getElementById(`model-option-${active}`)?.scrollIntoView({ block: "nearest" });
  } else {
    elements.modelInput.removeAttribute("aria-activedescendant");
  }
}

// The model field sits near the bottom of the panel, so open upwards when there is not
// enough room below rather than pushing the list out of the iframe.
function placeModelList() {
  const rect = elements.modelCombo.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - 16;
  const above = rect.top - 16;
  const openAbove = below < 200 && above > below;
  elements.modelListbox.classList.toggle("is-above", openAbove);
  elements.modelListbox.style.maxHeight = `${Math.max(120, Math.min(260, openAbove ? above : below))}px`;
}

function pickModel(id) {
  elements.modelInput.value = id;
  closeModelList();
  elements.modelInput.focus();
  showModelNotice();
}

function moveModelActive(step) {
  const count = popupState.modelVisible.length;

  if (!count) {
    return;
  }

  const next = popupState.modelActiveIndex + step;
  popupState.modelActiveIndex = next < 0 ? count - 1 : next >= count ? 0 : next;
  renderModelList();
}

function handleModelKeydown(event) {
  // While an IME is composing, arrows pick candidates and Enter commits the text: those
  // keys belong to the input method, not to the list.
  if (event.isComposing || event.keyCode === 229) {
    return;
  }

  const hasSuggestions = Boolean(popupState.modelResult?.models.length);

  if (event.key === "ArrowDown" && hasSuggestions) {
    event.preventDefault();
    if (!isModelListOpen()) {
      openModelList("");
    }
    moveModelActive(1);
    return;
  }

  if (!isModelListOpen()) {
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveModelActive(-1);
  } else if (event.key === "Enter" && popupState.modelActiveIndex >= 0) {
    // Only an option the user moved to is taken; otherwise Enter saves what was typed.
    event.preventDefault();
    pickModel(popupState.modelVisible[popupState.modelActiveIndex]);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeModelList();
  } else if (event.key === "Enter" || event.key === "Tab") {
    closeModelList();
  }
}

function bindModelCombo() {
  elements.modelInput.addEventListener("keydown", handleModelKeydown);
  elements.modelInput.addEventListener("input", () => openModelList(elements.modelInput.value));
  elements.modelInput.addEventListener("click", () => {
    if (!isModelListOpen()) {
      openModelList("");
    }
  });
  elements.modelInput.addEventListener("change", showModelNotice);

  // Keep focus in the input while clicking the arrow or an option.
  elements.modelToggle.addEventListener("mousedown", (event) => event.preventDefault());
  elements.modelToggle.addEventListener("click", () => {
    if (isModelListOpen()) {
      closeModelList();
      return;
    }
    elements.modelInput.focus();
    openModelList("");
  });
  elements.modelListbox.addEventListener("mousedown", (event) => {
    if (event.target.closest("[data-value]")) {
      event.preventDefault();
    }
  });
  elements.modelListbox.addEventListener("click", (event) => {
    const option = event.target.closest("[data-value]");
    if (option) {
      pickModel(option.dataset.value);
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (isModelListOpen() && !elements.modelCombo.contains(event.target)) {
      closeModelList();
    }
  });
  window.addEventListener("resize", closeModelList);
}

function toggleApiKeyVisibility() {
  const isPassword = elements.apiKeyInput.type === "password";
  elements.apiKeyInput.type = isPassword ? "text" : "password";
  elements.toggleApiKeyButton.innerHTML = `<span aria-hidden="true">${isPassword ? "🙈" : "👁"}</span>`;
}

// ---------------------------------------------------------------------------
// 我的信息
//
// 表单每个输入框带 data-kind / data-row / data-field，保存时整张表单读出来交给
// ResumeProProfile.profileFromEntries 还原，只写 profile 这一个键。

function applyTabFromHash() {
  const tab = typeof location !== "undefined" ? location.hash.replace(/^#/, "").split(":")[0] : "";

  if (tab && elements.tabPanels.some((panel) => panel.dataset.panel === tab)) {
    popupState.activeTab = tab;
    setActiveTab(tab);
  }
}

// 基础信息是「按方向各存一份」的，所以这一页要先说清楚正在编辑哪一份，并允许就地切换。
function renderProfileScope(store) {
  const api = self.ResumeProProfile;
  const entry = api.activeEntry(store);
  popupState.editingEntryId = entry?.id || "";
  const entries = Array.isArray(store?.templates) ? store.templates : [];

  if (elements.profileDirectionSelect) {
    elements.profileDirectionSelect.innerHTML = entries.length
      ? entries.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === entry?.id ? " selected" : ""}>${escapeHtml(item.name || "未命名")}</option>`).join("")
      : '<option value="">还没有我的信息</option>';
    elements.profileDirectionSelect.disabled = !entries.length;
  }
  if (elements.profileAddEntry) {
    elements.profileAddEntry.disabled = popupState.profileDirty;
  }
  if (elements.profileCopyEntry) {
    elements.profileCopyEntry.disabled = popupState.profileDirty || !entry;
  }
  if (elements.profileRenameEntry) {
    elements.profileRenameEntry.disabled = popupState.profileDirty || !entry;
  }

  if (elements.profileScopeNote) {
    elements.profileScopeNote.textContent = entry
      ? `下面填的是「${entry.name || "未命名"}」这一份的基础信息；切换方向后各存各的，互不影响。`
      : "还没有我的信息。先到「我的信息」页建一份，这里填的内容会在建第一份时继承过去。";
  }
}

async function createNewEntry(mode = "empty") {
  if (popupState.profileDirty) {
    showStatus("profile", "这份还没保存，先点「保存」再新建信息。", "warning", 0);
    return;
  }

  let created;
  const state = await StorageService.update((draft) => {
    const current = self.ResumeProProfile.activeEntry(draft);
    const copied = mode === "copy" && current;
    created = {
      id: crypto.randomUUID(),
      name: resolveTemplateName(copied ? `${current.name || "未命名"}-副本` : "新建信息", draft.templates),
      groups: copied ? structuredClone(current.groups || []) : [],
      profile: copied
        ? self.ResumeProProfile.normalizeProfile(structuredClone(current.profile || draft.profile))
        : self.ResumeProProfile.emptyProfile()
    };
    draft.templates.unshift(created);
    draft.activeTemplateId = created.id;
    return draft;
  });

  renderProfile(self.ResumeProProfile.entryProfile(state), state);
  renderTemplates(state);
  setActiveTab("profile");
  showStatus("profile", `${mode === "copy" ? "已复制" : "已新建"}「${created.name}」，可以继续修改基础信息。`, "success", 6000);
}

async function showProfileRenameEditor() {
  if (popupState.profileDirty) return;
  const state = await StorageService.getState();
  const entry = self.ResumeProProfile.activeEntry(state);
  if (!entry) return;
  elements.profileRenameInput.value = entry.name || "";
  elements.profileRenameConfirm.hidden = false;
  elements.profileRenameInput.focus?.();
  elements.profileRenameInput.select?.();
}

function hideProfileRenameEditor() {
  elements.profileRenameConfirm.hidden = true;
}

async function commitProfileRename() {
  const name = String(elements.profileRenameInput?.value || "").trim();
  const state = await StorageService.getState();
  const entry = self.ResumeProProfile.activeEntry(state);
  if (!entry) return;
  if (!name) {
    showStatus("profile", "名字不能为空。", "error", 0);
    return;
  }
  const updated = await StorageService.update((draft) => {
    const target = self.ResumeProProfile.activeEntry(draft);
    if (target) target.name = name;
    return draft;
  });
  hideProfileRenameEditor();
  renderProfileScope(updated);
  renderTemplates(updated);
  showStatus("profile", `已改名为「${name}」。`, "success");
}

async function handleProfileDirectionChange() {
  const api = self.ResumeProProfile;
  const id = elements.profileDirectionSelect?.value || "";

  if (!id || id === popupState.editingEntryId) {
    return;
  }

  if (popupState.profileDirty) {
    showStatus("profile", "这份还没保存，先点「保存」再切方向。", "warning", 0);
    elements.profileDirectionSelect.value = popupState.editingEntryId;
    return;
  }

  const state = await StorageService.setActiveTemplate(id);
  renderProfile(api.entryProfile(state), state);
  renderTemplates(state);
  showStatus("profile", `正在编辑「${api.activeEntry(state)?.name || "未命名"}」的基础信息。`, "success");
}

function renderProfile(profile, store) {
  const api = self.ResumeProProfile;

  renderProfileScope(store);

  elements.profilePreset.innerHTML = api.PROFILE_SCHEMA.map((group, index) => `
    <section class="profile-group" id="profile-section-${encodeURIComponent(group.name)}">
      <h3 class="profile-group__title">${escapeHtml(group.name)}</h3>
      <div class="profile-grid">
        ${group.fields.map((field) => profileInputHtml(field, profile.values[field.id] || "", `data-kind="value" data-field="${escapeHtml(field.id)}"`)).join("")}
      </div>
    </section>
  `).join("");
  elements.profileEducation.innerHTML = profile.education.map(educationRowHtml).join("");
  elements.profileFamily.innerHTML = profile.family.map(familyRowHtml).join("");
  const extra = api.EXTRA_GROUP_SCHEMAS;
  elements.profileExtraGroups.innerHTML = extra.map((schema) => extraGroupHtml(schema, profile.extraGroups?.[schema.id] || [])).join("");
  elements.profileCustom.innerHTML = profile.custom.map(customRowHtml).join("");
  renderProfileIndex(api.PROFILE_SCHEMA.map((group) => group.name).concat(["教育经历", "家庭主要成员"], extra.map((schema) => schema.name), ["补充字段"]));
  setupProfileIndexObserver();
}

function renderProfileIndex(names) {
  if (!elements.profileIndex) return;
  elements.profileIndex.innerHTML = names.map((name) => {
    const extra = self.ResumeProProfile.EXTRA_GROUP_SCHEMAS.find((schema) => schema.name === name);
    const target = extra
      ? `profile-section-${extra.id}`
      : ["教育经历", "家庭主要成员", "补充字段"].includes(name)
        ? `profile-section-${name === "教育经历" ? "education" : name === "家庭主要成员" ? "family" : "custom"}`
        : `profile-section-${encodeURIComponent(name)}`;
    return `<button class="profile-index__item" type="button" data-profile-index-target="${target}">${escapeHtml(name)}</button>`;
  }).join("");
}

function setupProfileIndexObserver() {
  if (!elements.profileIndex || typeof IntersectionObserver === "undefined") return;
  popupState.profileIndexObserver?.disconnect?.();
  const sections = [...document.querySelectorAll("#profile-form .profile-group[id]")];
  const buttons = [...elements.profileIndex.querySelectorAll("[data-profile-index-target]")];
  const byId = new Map(buttons.map((button) => [button.dataset.profileIndexTarget, button]));
  popupState.profileIndexObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!visible) return;
    buttons.forEach((button) => button.classList.toggle("is-active", button === byId.get(visible.target.id)));
  }, { root: null, rootMargin: "-18% 0px -65% 0px", threshold: [0, 1] });
  sections.forEach((section) => popupState.profileIndexObserver.observe(section));
}


function handleProfileIndexClick(event) {
  const button = event.target.closest("[data-profile-index-target]");
  if (!button) return;
  const target = document.getElementById(button.dataset.profileIndexTarget);
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
  button.classList.add("is-active");
}
function profileInputHtml(field, value, dataAttributes) {
  const id = `profile-input-${++popupState.profileRowSeq}`;
  const label = `<label for="${id}"><span>${escapeHtml(field.label || field.key)}</span></label>`;
  const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : "";

  if (field.type === "select") {
    // 备份里带来的值不在选项里时也要显示出来，不能保存一次就悄悄丢掉。
    const options = !value || field.options.includes(value) ? field.options : [...field.options, value];
    return `
      <div class="field-block">
        ${label}
        <select id="${id}" ${dataAttributes}>
          <option value=""></option>
          ${options.map((option) => `<option value="${escapeHtml(option)}"${option === value ? " selected" : ""}>${escapeHtml(option)}</option>`).join("")}
        </select>
      </div>
    `;
  }

  if (field.type === "textarea") {
    return `
      <div class="field-block profile-field--wide">
        ${label}
        <textarea id="${id}" rows="2" ${dataAttributes}${placeholder}>${escapeHtml(value)}</textarea>
      </div>
    `;
  }

  // 旧档案只有年月时先保留原文，避免 date 控件把不完整值清空。
  const incompleteDate = field.type === "date" && value && !/^\d{4}-\d{2}-\d{2}$/.test(value);
  const inputType = incompleteDate ? "text" : (["month", "date"].includes(field.type) ? field.type : "text");
  return `
    <div class="field-block">
      ${label}
      <input id="${id}" type="${inputType}" value="${escapeHtml(value)}" autocomplete="off" ${dataAttributes}${placeholder}>
      ${incompleteDate ? '<small>请补全为 YYYY-MM-DD，保存后可使用日期选择框。</small>' : ""}
    </div>
  `;
}

function familyRowHtml(member) {
  const api = self.ResumeProProfile;
  const row = ++popupState.profileRowSeq;
  const attributes = (field) => `data-kind="family" data-row="${row}" data-field="${field}"`;

  return `
    <div class="profile-row">
      ${profileInputHtml({ key: "关系", type: "select", options: api.FAMILY_RELATIONS }, member.relation || "", attributes("relation"))}
      ${api.FAMILY_FIELDS.map((field) => profileInputHtml(field, member[field.id] || "", attributes(field.id))).join("")}
      <div class="profile-row__actions">
        <button class="text-button" type="button" data-remove-row>删除</button>
      </div>
    </div>
  `;
}

function educationRowHtml(record) {
  const api = self.ResumeProProfile;
  const row = ++popupState.profileRowSeq;
  const attributes = (field) => `data-kind="education" data-row="${row}" data-field="${field}"`;
  const title = [record.schoolName, record.eduLevel, record.majorName].filter(Boolean).join(" · ");

  return `
    <div class="profile-row profile-row--education">
      <div class="profile-row__heading"><strong>教育经历${title ? `：${escapeHtml(title)}` : ""}</strong></div>
      ${api.EDUCATION_FIELDS.map((field) => profileInputHtml(field, record[field.id] || "", attributes(field.id))).join("")}
      <div class="profile-row__actions">
        <button class="text-button" type="button" data-remove-row>删除本段</button>
      </div>
    </div>
  `;
}

function extraGroupHtml(schema, rows) {
  const safeRows = rows.length ? rows : [{}];
  return `<section class="profile-group" id="profile-section-${schema.id}">
    <h3 class="profile-group__title">${escapeHtml(schema.name)}</h3>
    <div class="profile-rows">${safeRows.map((row) => extraRowHtml(schema, row)).join("")}</div>
    <button class="secondary-button" type="button" data-add-extra-group="${schema.id}">添加${escapeHtml(schema.name)}</button>
  </section>`;
}

function extraRowHtml(schema, row) {
  const rowId = ++popupState.profileRowSeq;
  const attributes = (field) => `data-kind="extra" data-extra-group="${schema.id}" data-row="${rowId}" data-field="${field}"`;
  return `<div class="profile-row">
    <div class="profile-row__heading"><strong>${escapeHtml(schema.name)}</strong></div>
    ${schema.fields.map((field) => profileInputHtml(field, row[field.id] || "", attributes(field.id))).join("")}
    <div class="profile-row__actions"><button class="text-button" type="button" data-remove-row>删除本段</button></div>
  </div>`;
}
function customRowHtml(item) {
  const row = ++popupState.profileRowSeq;
  const attributes = (field) => `data-kind="custom" data-row="${row}" data-field="${field}"`;
  return `
    <div class="profile-row${item.key && !item.value ? " is-pending" : ""}">
      ${profileInputHtml({ key: "字段名" }, item.key, attributes("key"))}
      ${profileInputHtml({ key: "内容" }, item.value, attributes("value"))}
      <div class="profile-row__actions"><button class="text-button" type="button" data-remove-row>删除</button></div>
    </div>
  `;
}

function readProfileForm() {
  const entries = Array.from(elements.profileForm.querySelectorAll("[data-kind]")).map((input) => ({
    kind: input.dataset.kind,
    row: input.dataset.row,
    group: input.dataset.extraGroup || "",
    field: input.dataset.field,
    value: input.value
  }));

  return self.ResumeProProfile.profileFromEntries(entries);
}

async function handleProfileSubmit(event) {
  event.preventDefault();
  await saveProfile(readProfileForm());
}

async function saveProfile(profile) {
  const api = self.ResumeProProfile;
  const state = await StorageService.update((draft) => {
    const entry = api.activeEntry(draft);

    if (entry) {
      // 各方向各存一份，保存只落在当前这一份上。
      entry.profile = profile;
    } else {
      // 首次保存直接建立可见的「我的信息」，避免只存到隐藏的全局档案。
      const created = {
        id: crypto.randomUUID(),
        name: String(profile?.values?.name || "").trim() || "新建信息",
        groups: [],
        profile
      };
      draft.templates.unshift(created);
      draft.activeTemplateId = created.id;
    }

    return draft;
  });

  const saved = api.entryProfile(state);
  renderProfile(saved, state);
  renderTemplates(state);

  const count = api.countProfileValues(saved);
  const pending = api.countPendingFields(saved);

  showStatus(
    "profile",
    pending ? `已保存 ${count} 项，还有 ${pending} 个字段没填内容。` : `已保存 ${count} 项。`,
    "success",
    pending ? 0 : 2200
  );

  return state;
}

function markProfileDirty() {
  popupState.profileDirty = true;
}

function handleProfileRemoveClick(event) {
  const button = event.target.closest?.("[data-remove-row]");

  if (!button) {
    return;
  }

  button.closest(".profile-row")?.remove();
  markProfileDirty();
}

// 备份和我的信息一样过一遍密码 / 验证码剔除。补充字段是用户自己起的名，拦不住一行叫「登录密码」。
function stripProfileSecrets(profile) {
  const { isSecretFieldName, isSecretFieldValue } = self.ResumeProSecretFields;
  const next = self.ResumeProProfile.normalizeProfile(profile);
  let omitted = 0;

  for (const [id, value] of Object.entries(next.values)) {
    if (isSecretFieldValue(value)) {
      delete next.values[id];
      omitted += 1;
    }
  }

  next.custom = next.custom.filter((item) => {
    const secret = isSecretFieldName(item.key) || isSecretFieldValue(item.value);
    if (secret) omitted += 1;
    return !secret;
  });

  for (const member of next.family) {
    for (const field of self.ResumeProProfile.FAMILY_FIELDS) {
      if (member[field.id] && isSecretFieldValue(member[field.id])) {
        member[field.id] = "";
        omitted += 1;
      }
    }
  }
  next.family = self.ResumeProProfile.normalizeProfile({ family: next.family }).family;

  return { profile: next, omitted };
}

function describeBackupContents(backup) {
  const parts = [];
  if (backup.templates.length) parts.push(`${backup.templates.length} 份我的信息`);
  if (backup.profile) parts.push("基础信息");
  return parts.join("和");
}

async function deleteTemplate(templateId) {
  const state = await StorageService.update((draft) => {
    draft.templates = draft.templates.filter((template) => template.id !== templateId);

    if (!draft.templates.some((template) => template.id === draft.activeTemplateId)) {
      draft.activeTemplateId = draft.templates[0]?.id || "";
    }

    return draft;
  });

  const message = state.templates.length
    ? "已删除这份我的信息。"
    : "已删除这份我的信息，当前没有可用的我的信息了。";

  showStatus("template", message, "success");
}

// ---------------------------------------------------------------------------
// 备份 / 导出
//
// Excel 只装得下一份我的信息的字段，而我的信息列表、当前用哪一个、AI 配置都只活在
// chrome.storage.local 里。换电脑或者换扩展 ID 之后这些东西没有出口，所以这里
// 补一个 JSON 备份。配对信息和待同步队列不进备份，那些换个环境本来就要重来。
//
// data-privacy §4.1：密码、验证码这类东西不得出现在备份里。这些字段是用户自己填的
// 表格，拦不住一行叫「登录密码」，所以写文件前再过一道快照那套剔除规则。
// API Key 走 §4.1.1 的例外：默认不含，用户勾选并再确认一次才写进去。

async function handleExportBackup() {
  const state = await StorageService.getState();

  if (!state.templates.length && !self.ResumeProProfile.hasProfileContent(state.profile)) {
    showStatus("backup", "还没有可导出的我的信息。", "warning");
    return;
  }

  // 勾选框太容易顺手点上，真要写 Key 进文件之前再拦一次（data-privacy §4.1.1）。
  if (elements.backupIncludeKey.checked && state.aiConfig.apiKey) {
    elements.backupKeyConfirm.hidden = false;
    hideStatus("backup");
    return;
  }

  await exportBackup(false);
}

async function exportBackup(includeApiKey) {
  hideKeyConfirm();

  try {
    const state = await StorageService.getState();
    const report = buildBackup(state, { includeApiKey });

    BackupIO.saveJson(backupFileName(), report.backup);

    const notes = [];
    if (report.omittedFieldCount) notes.push(`跳过 ${report.omittedFieldCount} 个密码 / 验证码类字段`);
    if (report.droppedTemplateCount) notes.push(`${report.droppedTemplateCount} 份我的信息因此没有内容，未写入`);
    if (report.endpointRedacted) notes.push("接口地址里的凭据参数已去掉");

    showStatus(
      "backup",
      notes.length
        ? `已导出 ${describeBackupContents(report.backup)}，${notes.join("，")}。`
        : `已导出 ${describeBackupContents(report.backup)}。`,
      "success",
      notes.length ? 6000 : 2200
    );
  } catch (error) {
    showStatus("backup", `导出失败：${error.message}`, "error", 0);
  }
}

async function handleBackupFileSelection(event) {
  const [file] = event.target.files || [];
  elements.backupFileInput.value = "";
  hideBackupConfirm();

  if (!file) {
    return;
  }

  try {
    const backup = parseBackup(await file.text());
    const state = await StorageService.getState();

    // 刚装完、或者换了扩展 ID，没有东西可覆盖，直接恢复。
    if (!state.templates.length && !self.ResumeProProfile.hasProfileContent(state.profile)) {
      await applyAndSave(backup, "replace");
      return;
    }

    popupState.pendingBackup = backup;
    elements.backupConfirmText.textContent = `备份里有 ${describeBackupContents(backup)}。`;
    elements.backupConfirm.hidden = false;
    hideStatus("backup");
  } catch (error) {
    showStatus("backup", `导入失败：${error.message}`, "error", 0);
  }
}

async function commitPendingBackup(mode) {
  const backup = popupState.pendingBackup;

  if (!backup) {
    return;
  }

  hideBackupConfirm();

  try {
    await applyAndSave(backup, mode);
  } catch (error) {
    showStatus("backup", `导入失败：${error.message}`, "error", 0);
  }
}

async function applyAndSave(backup, mode) {
  const state = await StorageService.getState();
  await StorageService.saveState(applyBackup(state, backup, mode));
  await render();

  showStatus(
    "backup",
    mode === "replace"
      ? `已恢复 ${describeBackupContents(backup)}。`
      : `已追加 ${describeBackupContents(backup)}。`,
    "success"
  );
}

function hideKeyConfirm() {
  elements.backupKeyConfirm.hidden = true;
}

function hideBackupConfirm() {
  popupState.pendingBackup = null;
  elements.backupConfirm.hidden = true;
}

function buildBackup(state, { includeApiKey = false, now = new Date() } = {}) {
  const { redactUrlCredentials, stripSecretFields } = self.ResumeProSecretFields;
  let omittedFieldCount = 0;

  const templates = [];
  let droppedTemplateCount = 0;
  let profileContent = false;

  for (const template of state.templates) {
    const stripped = stripSecretFields(template);
    omittedFieldCount += stripped.omittedFieldCount;

    // 每份我的信息自带的基础信息也一起写进文件，同样过一遍密码 / 验证码剔除。
    const entryProfile = stripProfileSecrets(template.profile ?? {});
    omittedFieldCount += entryProfile.omitted;
    const entryHasProfile = self.ResumeProProfile.hasProfileContent(entryProfile.profile);
    if (!stripped.groups.length && !entryHasProfile) {
      droppedTemplateCount += 1;
      continue;
    }
    profileContent = profileContent || entryHasProfile;

    templates.push({
      id: template.id,
      name: template.name,
      groups: stripped.groups,
      ...(entryHasProfile ? { profile: entryProfile.profile } : {})
    });
  }

  const strippedProfile = stripProfileSecrets(state.profile);
  const includeProfile = profileContent || self.ResumeProProfile.hasProfileContent(strippedProfile.profile);
  omittedFieldCount += strippedProfile.omitted;

  if (!templates.length && !includeProfile) {
    throw new Error("剩下的内容都是密码 / 验证码这类，没有可以写进备份的内容。");
  }

  // 有些 OpenAI 兼容接口把凭据放在地址里（?key=…）。不勾「包含 API Key」就一起去掉，
  // 否则说着不含 Key 却把它藏在 apiUrl 里。
  const endpoint = includeApiKey
    ? { url: state.aiConfig.apiUrl, changed: false }
    : redactUrlCredentials(state.aiConfig.apiUrl);

  return {
    backup: {
      format: BACKUP_FORMAT,
      formatVersion: includeProfile ? BACKUP_FORMAT_VERSION : 1,
      exportedAt: now.toISOString(),
      pluginVersion: chrome.runtime.getManifest().version,
      templates,
      activeTemplateId: state.activeTemplateId,
      ...(includeProfile ? { profile: strippedProfile.profile } : {}),
      aiConfig: includeApiKey && state.aiConfig.apiKey
        ? { apiUrl: endpoint.url, model: state.aiConfig.model, apiKey: state.aiConfig.apiKey }
        : { apiUrl: endpoint.url, model: state.aiConfig.model }
    },
    omittedFieldCount,
    droppedTemplateCount,
    endpointRedacted: endpoint.changed
  };
}

function parseBackup(text) {
  let raw;

  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("文件不是有效的 JSON。");
  }

  if (!raw || typeof raw !== "object" || raw.format !== BACKUP_FORMAT) {
    throw new Error("这不是 Resume Pro 的备份文件。");
  }

  const version = Number(raw.formatVersion);

  if (!Number.isInteger(version) || version < 1) {
    throw new Error("备份文件已损坏。");
  }

  if (version > BACKUP_FORMAT_VERSION) {
    throw new Error("备份来自更新版本的插件，请先更新插件。");
  }

  const templates = Array.isArray(raw.templates)
    ? raw.templates.map((entry) => {
        const template = normalizeTemplate(entry);
        if (!template) return null;
        const profile = self.ResumeProProfile.normalizeProfile(entry?.profile);
        if (!template.groups.length && !self.ResumeProProfile.hasProfileContent(profile)) return null;
        return { ...template, profile };
      }).filter(Boolean)
    : [];

  const profile = raw.profile && typeof raw.profile === "object"
    ? self.ResumeProProfile.normalizeProfile(raw.profile)
    : null;
  const hasProfile = Boolean(profile && self.ResumeProProfile.hasProfileContent(profile));

  if (!templates.length && !hasProfile) {
    throw new Error("备份里没有我的信息。");
  }

  return {
    templates,
    activeTemplateId: typeof raw.activeTemplateId === "string" ? raw.activeTemplateId : "",
    aiConfig: raw.aiConfig && typeof raw.aiConfig === "object" ? raw.aiConfig : null,
    profile: hasProfile ? profile : null
  };
}

function applyBackup(state, backup, mode) {
  const next = structuredClone(state);
  // 只有「基础信息」的备份，替换也不能把本机的我的信息清空。
  const templates = mode === "replace" && backup.templates.length ? [] : next.templates;
  let activeTemplateId = "";

  backup.templates.forEach((template) => {
    const copy = structuredClone(template);

    // 追加时备份里的 id 可能已经在用，撞上就换一个，否则两张卡片指向同一份我的信息。
    if (templates.some((item) => item.id === copy.id)) {
      copy.id = crypto.randomUUID();
    }

    copy.name = resolveTemplateName(copy.name, templates);
    templates.push(copy);

    if (!activeTemplateId || template.id === backup.activeTemplateId) {
      activeTemplateId = copy.id;
    }
  });

  next.templates = templates;
  next.activeTemplateId = activeTemplateId
    || (templates.some((template) => template.id === state.activeTemplateId) ? state.activeTemplateId : "")
    || next.templates[0]?.id
    || "";

  // 旧备份没有这一项，本机的保持不动；追加时本机已填的不被覆盖。
  if (backup.profile) {
    next.profile = mode === "replace"
      ? backup.profile
      : self.ResumeProProfile.mergeProfiles(next.profile, backup.profile);
  }

  if (backup.aiConfig) {
    const apiUrl = String(backup.aiConfig.apiUrl ?? next.aiConfig.apiUrl);

    // 备份自己带 Key 的话，Key 和地址是一起导出的，配在一起是对的。备份没带 Key
    // 就只在地址没变时接着用本机这个；地址变了必须清掉，否则下一次请求会把用户的
    // Key 发到别人备份里的地址上。
    const backupKey = typeof backup.aiConfig.apiKey === "string" ? backup.aiConfig.apiKey : "";

    next.aiConfig = {
      apiUrl,
      model: String(backup.aiConfig.model ?? next.aiConfig.model),
      apiKey: backupKey || (apiUrl === next.aiConfig.apiUrl ? next.aiConfig.apiKey : "")
    };
  }

  return next;
}

async function exportTemplateToExcel(templateId) {
  const state = await StorageService.getState();
  const template = state.templates.find((item) => item.id === templateId);

  if (!template) {
    showStatus("template", "这份我的信息不存在。", "error", 0);
    return;
  }

  try {
    BackupIO.saveWorkbook(templateToSheetRows(template), templateExportFileName(template.name));
    showStatus("template", `已导出 ${countTemplateFields(template)} 个字段。`, "success");
  } catch (error) {
    showStatus("template", `导出失败：${error.message}`, "error", 0);
  }
}

// 表头和列序跟 parseTemplateFile 读的是同一套，导出的文件能原样再导回来。
// 这里不剔密码类字段：它是用户自己那份 Excel 的往返，剔了就导不回去了。
function templateToSheetRows(template) {
  const rows = [[...TEMPLATE_SHEET_HEADER]];

  (Array.isArray(template.groups) ? template.groups : []).forEach((group) => {
    (Array.isArray(group.fields) ? group.fields : []).forEach((field) => {
      rows.push([group.name, field.key, field.value]);
    });
  });

  return rows;
}

function backupFileName(now = new Date()) {
  return `resume-pro-backup-${formatDate(now)}.json`;
}

// 名字取自文件名，所以这里保留原名，只去掉文件系统不收的字符。
function templateExportFileName(templateName) {
  const safe = String(templateName ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .trim();

  return `${safe || "我的信息"}.xlsx`;
}

const BackupIO = {
  saveJson(fileName, data) {
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), fileName);
  },

  saveWorkbook(rows, fileName) {
    if (typeof XLSX === "undefined") {
      throw new Error("未找到 Excel 生成库。");
    }

    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "我的信息");
    XLSX.writeFile(workbook, fileName);
  }
};

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  // 立刻回收会让下载来不及读到数据，放到下一轮任务里。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function parseTemplateFile(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();

  if (!["xlsx", "csv"].includes(extension || "")) {
    throw new Error("仅支持 .xlsx 或 .csv 文件。");
  }

  if (typeof XLSX === "undefined") {
    throw new Error("未找到 Excel 解析库。");
  }

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    throw new Error("文件中没有可用工作表。");
  }

  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    blankrows: false,
    defval: ""
  });

  if (!rows.length) {
    throw new Error("Excel 内容为空。");
  }

  const dataRows = rows.slice(1);
  const groupOrder = [];
  const groupMap = new Map();
  const missingKeyRows = [];

  dataRows.forEach((row, index) => {
    const groupName = String(row[0] ?? "").trim();
    const fieldKey = String(row[1] ?? "").trim();
    const fieldValue = String(row[2] ?? "").trim();

    if (!groupName && !fieldKey && !fieldValue) {
      return;
    }

    // Collect every offending row instead of stopping at the first one, so a hand-edited
    // sheet can be fixed in a single pass.
    if (!fieldKey) {
      missingKeyRows.push(index + 2);
      return;
    }

    if (!groupMap.has(groupName || "未分类")) {
      groupMap.set(groupName || "未分类", []);
      groupOrder.push(groupName || "未分类");
    }

    groupMap.get(groupName || "未分类").push({
      key: fieldKey,
      value: fieldValue
    });
  });

  if (missingKeyRows.length) {
    throw new Error(buildMissingKeyMessage(missingKeyRows));
  }

  const groups = groupOrder.map((groupName) => ({
    name: groupName,
    fields: groupMap.get(groupName)
  }));

  if (!groups.length) {
    throw new Error("未解析到任何字段，请检查 Excel 格式。");
  }

  return groups;
}

// A hand-edited sheet needs every offending row number, or the user fixes what is listed,
// re-imports and fails again. Past a couple of dozen the cause is almost always a shifted
// column rather than individual typos, and a wall of numbers helps nobody — so say that
// instead.
function buildMissingKeyMessage(rowNumbers) {
  if (rowNumbers.length > MAX_LISTED_ROW_NUMBERS) {
    return `共 ${rowNumbers.length} 行缺少「字段名」（第二列），请检查第二列是不是整列错位了。`;
  }

  return `第 ${rowNumbers.join("、")} 行缺少「字段名」（第二列）。`;
}

function getTemplateNameFromFile(fileName) {
  return fileName.replace(/\.[^.]+$/, "").trim() || "未命名";
}

function countTemplateFields(template) {
  if (!Array.isArray(template.groups)) {
    return 0;
  }

  return template.groups.reduce((total, group) => {
    const fields = Array.isArray(group.fields) ? group.fields.length : 0;
    return total + fields;
  }, 0);
}

const INLINE_STATUS_TYPES = new Set(["model", "url"]);

function statusBaseClass(type) {
  return INLINE_STATUS_TYPES.has(type) ? "status-message is-inline" : "status-message";
}

function showStatus(type, message, variant, autoHideDelay = 2200) {
  const element = elements[`${type}Status`];

  element.textContent = message;
  element.className = `${statusBaseClass(type)} is-visible is-${variant}`;

  if (popupState.statusTimers[type]) {
    clearTimeout(popupState.statusTimers[type]);
  }

  if (autoHideDelay > 0) {
    popupState.statusTimers[type] = setTimeout(() => hideStatus(type), autoHideDelay);
  }
}

function hideStatus(type) {
  const element = elements[`${type}Status`];
  clearTimeout(popupState.statusTimers[type]);
  element.className = statusBaseClass(type);
  element.textContent = "";
}

function normalizeStore(rawState) {
  const templates = Array.isArray(rawState.templates)
    ? rawState.templates
        .map((rawEntry) => {
          const template = normalizeTemplate(rawEntry);

          if (!template) {
            return null;
          }

          // 每份「我的信息」自带一份基础信息（互不干扰）。注意必须从原始条目取 profile：
          // normalizeTemplate 只保留 id/name/groups，取它身上的 profile 会永远拿不到，
          // 于是每次写入都被全局那份（通常是空的）覆盖 —— 踩过。
          // 老数据里没有自己那份的，用全局那份补齐，等于一次性迁移，用户不用做任何事。
          return {
            ...template,
            profile: self.ResumeProProfile.normalizeProfile(rawEntry?.profile ?? rawState.profile)
          };
        })
        .filter(Boolean)
    : [];

  const activeTemplateId = typeof rawState.activeTemplateId === "string"
    ? rawState.activeTemplateId
    : DEFAULT_STORE.activeTemplateId;

  const resolvedActiveTemplateId = templates.some((template) => template.id === activeTemplateId)
    ? activeTemplateId
    : templates[0]?.id || "";

  const sharedProfile = self.ResumeProProfile.normalizeProfile(rawState.profile);

  return {
    templates,
    activeTemplateId: resolvedActiveTemplateId,
    aiConfig: normalizeAiConfig(rawState.aiConfig),
    profile: sharedProfile
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

function normalizeAiConfig(aiConfig) {
  const value = aiConfig && typeof aiConfig === "object" ? aiConfig : {};

  return {
    apiUrl: String(value.apiUrl ?? DEFAULT_STORE.aiConfig.apiUrl).trim() || DEFAULT_STORE.aiConfig.apiUrl,
    model: String(value.model ?? DEFAULT_STORE.aiConfig.model).trim() || DEFAULT_STORE.aiConfig.model,
    apiKey: String(value.apiKey ?? "")
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

async function initializeUpdateFeature() {
  const currentVersion = chrome.runtime.getManifest().version;
  elements.currentVersion.textContent = `当前 v${currentVersion}`;
  await checkForUpdates({ force: false, announce: false });
}

async function checkForUpdates({ force, announce }) {
  const currentVersion = chrome.runtime.getManifest().version;
  let cached = null;
  let dismissedVersion = null;
  elements.checkUpdateButton.disabled = true;

  if (announce) {
    elements.updateCheckStatus.textContent = "检查中...";
  }

  try {
    const stored = await chrome.storage.local.get([UPDATE_CACHE_KEY, UPDATE_DISMISSED_KEY]);
    cached = stored[UPDATE_CACHE_KEY];
    dismissedVersion = stored[UPDATE_DISMISSED_KEY];
    const cacheInterval = cached?.failed ? UPDATE_FAILURE_RETRY_MS : UPDATE_CHECK_INTERVAL_MS;

    if (!force && ResumeProUtils.shouldUseUpdateCache(cached?.checkedAt, Date.now(), cacheInterval)) {
      renderUpdateBanner(cached?.release || null, dismissedVersion, currentVersion);
      return;
    }

    const response = await fetch(UPDATE_API_URL, {
      headers: {
        Accept: "application/vnd.github+json"
      }
    });

    if (response.status === 404) {
      await chrome.storage.local.set({
        [UPDATE_CACHE_KEY]: { checkedAt: Date.now(), release: null, failed: false }
      });
      renderUpdateBanner(null, dismissedVersion, currentVersion);
      if (announce) elements.updateCheckStatus.textContent = "暂无正式版本";
      return;
    }

    if (!response.ok) {
      throw new Error(`GitHub API HTTP ${response.status}`);
    }

    const release = ResumeProUtils.normalizeRelease(await response.json());
    if (!release) {
      throw new Error("GitHub Release 响应无效");
    }

    await chrome.storage.local.set({
      [UPDATE_CACHE_KEY]: { checkedAt: Date.now(), release, failed: false }
    });
    const hasUpdate = renderUpdateBanner(release, dismissedVersion, currentVersion);

    if (announce) {
      elements.updateCheckStatus.textContent = hasUpdate ? "发现新版" : "已是最新版";
    }
  } catch (error) {
    console.warn("Resume Pro update check failed:", error);
    await chrome.storage.local.set({
      [UPDATE_CACHE_KEY]: {
        checkedAt: Date.now(),
        release: cached?.release || null,
        failed: true
      }
    }).catch(() => {});
    renderUpdateBanner(cached?.release || null, dismissedVersion, currentVersion);
    if (announce) {
      elements.updateCheckStatus.textContent = "检查失败，不影响使用";
    }
  } finally {
    elements.checkUpdateButton.disabled = false;
  }
}

function renderUpdateBanner(release, dismissedVersion, currentVersion) {
  let hasUpdate = false;

  try {
    hasUpdate = Boolean(release)
      && ResumeProUtils.compareVersions(release.version, currentVersion) > 0
      && release.version !== dismissedVersion;
  } catch {
    hasUpdate = false;
  }

  popupState.availableRelease = hasUpdate ? release : null;
  elements.updateBanner.hidden = !hasUpdate;

  if (hasUpdate) {
    elements.updateTitle.textContent = `发现新版本 ${release.version}`;
    elements.updateSummary.textContent = release.summary;
  }

  return hasUpdate;
}

async function openAvailableRelease() {
  if (!popupState.availableRelease?.url) {
    return;
  }

  await chrome.tabs.create({ url: popupState.availableRelease.url });
}

async function dismissAvailableRelease() {
  if (!popupState.availableRelease?.version) {
    return;
  }

  await chrome.storage.local.set({
    [UPDATE_DISMISSED_KEY]: popupState.availableRelease.version
  });
  popupState.availableRelease = null;
  elements.updateBanner.hidden = true;
}

popupState.selectedParseFile = null;
popupState.statusTimers.parse = null;

document.addEventListener("DOMContentLoaded", () => {
  initResumeParsingFeature().catch((error) => {
    console.error("Resume Pro parse feature init failed:", error);
    showParseStatus(`解析功能初始化失败：${error.message}`, "error", 0);
  });
});

async function initResumeParsingFeature() {
  cacheParseElements();
  bindParseEvents();
  updateParseFileSelection(null);
}

function cacheParseElements() {
  elements.parseDropZone = document.getElementById("parse-drop-zone");
  elements.parseFileInput = document.getElementById("parse-file-input");
  elements.parseResumeButton = document.getElementById("parse-resume-button");
  elements.parseDownloadButton = document.getElementById("parse-download-button");
  elements.parseStatus = document.getElementById("parse-status");
  elements.parseProgress = document.getElementById("parse-progress");
  elements.parseProgressFill = document.getElementById("parse-progress-fill");
  elements.parseProgressLabel = document.getElementById("parse-progress-label");
  elements.parseDropLabel = document.getElementById("parse-drop-label");
  elements.parseSaveConfirm = document.getElementById("parse-save-confirm");
  elements.parseSaveConfirmText = document.getElementById("parse-save-confirm-text");
  elements.parseSaveNewButton = document.getElementById("parse-save-new-button");
  elements.parseSaveUpdateButton = document.getElementById("parse-save-update-button");
  elements.parseSaveCancelButton = document.getElementById("parse-save-cancel-button");
}

function bindParseEvents() {
  if (!elements.parseDropZone || !elements.parseFileInput || !elements.parseResumeButton) {
    return;
  }

  elements.parseDropZone.addEventListener("click", () => {
    elements.parseFileInput.click();
  });

  elements.parseDropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.parseDropZone.classList.add("is-dragover");
  });

  elements.parseDropZone.addEventListener("dragleave", () => {
    elements.parseDropZone.classList.remove("is-dragover");
  });

  elements.parseDropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.parseDropZone.classList.remove("is-dragover");
    const [file] = event.dataTransfer?.files || [];
    if (file) {
      updateParseFileSelection(file);
    }
  });

  elements.parseFileInput.addEventListener("change", (event) => {
    const [file] = event.target.files || [];
    updateParseFileSelection(file || null);
  });

  elements.parseResumeButton.addEventListener("click", handleParseResumeClick);
  elements.parseDownloadButton?.addEventListener("click", handleParseDownloadClick);

  // 解析完成后的三选一：新建一份 / 更新当前这份 / 先不保存。
  elements.parseSaveNewButton?.addEventListener("click", () => commitParsedResult("new"));
  elements.parseSaveUpdateButton?.addEventListener("click", () => commitParsedResult("update"));
  elements.parseSaveCancelButton?.addEventListener("click", discardParsedResult);
}

function setParseProgress(percent, label) {
  if (elements.parseProgress) elements.parseProgress.hidden = false;
  if (elements.parseProgressFill?.style) elements.parseProgressFill.style.width = `${percent}%`;
  if (elements.parseProgressLabel) elements.parseProgressLabel.textContent = label;
}

function hideParseProgress() {
  if (elements.parseProgress) elements.parseProgress.hidden = true;
}
function updateParseFileSelection(file) {
  popupState.selectedParseFile = file || null;

  if (elements.parseFileInput) {
    elements.parseFileInput.value = "";
  }

  if (elements.parseDropLabel) {
    elements.parseDropLabel.textContent = file
      ? file.name
      : "拖拽简历文件到此处，或点击选择";
  }

  if (elements.parseDropZone) {
    elements.parseDropZone.classList.toggle("has-file", Boolean(file));
  }

  if (elements.parseResumeButton) {
    elements.parseResumeButton.disabled = !file;
  }

  // 换了一份文件，上一份的「下载 Excel 核对」就不该再留着，免得下成旧简历。
  if (file) {
    popupState.lastParsedFields = [];
    if (elements.parseDownloadButton) elements.parseDownloadButton.hidden = true;
  }
}

async function handleParseResumeClick() {
  const file = popupState.selectedParseFile;

  if (!file) {
    showParseStatus("请先选择简历文件。", "error", 0);
    return;
  }

  const state = await StorageService.getState();
  const aiConfig = normalizeAiConfig(state.aiConfig);

  if (!aiConfig.apiUrl || !aiConfig.model || !aiConfig.apiKey) {
    showParseStatus("请先配置 AI 接口。", "error", 0);
    return;
  }

  const extension = file.name.split(".").pop()?.toLowerCase();

  if (!["pdf", "docx", "txt"].includes(extension || "")) {
    showParseStatus("仅支持 PDF、Word(.docx) 或 TXT。", "error", 0);
    return;
  }

  elements.parseResumeButton.disabled = true;
  elements.parseResumeButton.textContent = "解析中...";
  popupState.lastParsedFields = [];
  // 上一轮还没决定「新建 / 更新当前」的结果作废，避免连着解析两次时存错。
  popupState.pendingParsed = null;
  hideParseSaveConfirm();
  hideRenameRow();
  if (elements.parseDownloadButton) elements.parseDownloadButton.hidden = true;
  setParseProgress(10, "正在读取文件内容...");
  showParseStatus("正在本地读取简历...", "success", 0);

  try {
    const payload = await buildResumeParsePayload(file, extension);
    setParseProgress(35, "文件读取完成，正在发送给 AI...");
    showParseStatus("文件读取完成，正在调用 AI 提取简历信息...", "success", 0);
    const result = await self.ResumeProAIClient.send({
      type: "PARSE_RESUME",
      fileType: payload.fileType,
      content: payload.content,
      aiConfig
    });

    if (!result?.success) {
      throw new Error(result?.error || "简历解析失败。");
    }

    const fields = normalizeParsedResult(result.fields);
    setParseProgress(75, "AI 返回完成，正在整理字段...");
    // 先留住解析结果：下面保存就算失败，也还能下载 Excel，不用再调一次 AI。
    popupState.lastParsedFields = result.fields;
    if (elements.parseDownloadButton) elements.parseDownloadButton.hidden = false;

    const groups = parsedFieldsToGroups(fields);
    const fieldCount = countTemplateFields({ groups });
    setParseProgress(100, `解析完成，共 ${fieldCount} 个字段`);
    const state = await StorageService.getState();

    // 一份都还没有时不用问：直接存成第一份。
    if (!state.templates.length) {
      await saveParsedAsNew(groups, `${getTemplateNameFromFile(file.name)}（AI 解析）`);
      updateParseFileSelection(null);
      return;
    }

    // 已经有一份以上：让用户决定是再存一份（投另一个方向），还是更新当前这份。
    const current = state.templates.find((item) => item.id === state.activeTemplateId) || state.templates[0];
    popupState.pendingParsed = {
      groups,
      name: `${getTemplateNameFromFile(file.name)}（AI 解析）`,
      currentId: current?.id || ""
    };
    showParseSaveConfirm(fieldCount, current?.name || "");
    showParseStatus(`解析完成，共 ${fieldCount} 个字段。选择存成新的，还是更新当前这份。`, "success", 0);
  } catch (error) {
    setParseProgress(100, "解析失败");
    showParseStatus(error.message || "简历解析失败。", "error", 0);
  } finally {
    elements.parseResumeButton.textContent = "开始解析";
    elements.parseResumeButton.disabled = !popupState.selectedParseFile;
  }
}

function showParseSaveConfirm(fieldCount, currentName) {
  if (!elements.parseSaveConfirm) return;

  if (elements.parseSaveConfirmText) {
    elements.parseSaveConfirmText.textContent = currentName
      ? `解析完成，共 ${fieldCount} 个字段。要存成一份新的我的信息，还是更新当前「${currentName}」？`
      : `解析完成，共 ${fieldCount} 个字段。要存成一份新的我的信息吗？`;
  }

  if (elements.parseSaveUpdateButton) {
    elements.parseSaveUpdateButton.hidden = !currentName;
    elements.parseSaveUpdateButton.textContent = "更新当前这份";
  }

  elements.parseSaveConfirm.hidden = false;
}

function hideParseSaveConfirm() {
  if (elements.parseSaveConfirm) {
    elements.parseSaveConfirm.hidden = true;
  }
}

// 存成新的一份（比如「硬件方向」的简历解析出来，再存一份给「软件方向」）。
async function saveParsedAsNew(groups, baseName) {
  let saved = null;

  await StorageService.update((draft) => {
    saved = {
      id: crypto.randomUUID(),
      name: resolveTemplateName(baseName, draft.templates),
      groups,
      // 解析出的简历字段同时作为新档案的基础信息初始值，用户可以在基础信息页继续修改。
      profile: self.ResumeProProfile.profileFromResumeFields(self.ResumeProProfile.entryProfile(draft), groups)
    };
    draft.templates.unshift(saved);
    draft.activeTemplateId = saved.id;
    return draft;
  });

  showParseStatus(`已存成新的一份「${saved.name}」并设为当前，共 ${countTemplateFields(saved)} 个字段。`, "success", 0);
  return saved;
}

// 更新当前这份：名字保留（用户可能已经改成「硬件方向」），只换里面的字段。
async function saveParsedIntoActiveEntry(groups, targetId) {
  let saved = null;
  let missing = false;

  await StorageService.update((draft) => {
    const target = draft.templates.find((item) => item.id === targetId)
      || draft.templates.find((item) => item.id === draft.activeTemplateId);

    if (!target) {
      missing = true;
      return draft;
    }

    target.groups = groups;
    draft.activeTemplateId = target.id;
    saved = target;
    return draft;
  });

  if (missing) {
    throw new Error("要更新的这份我的信息不存在。");
  }

  showParseStatus(`已更新当前这份「${saved.name}」并设为当前，共 ${countTemplateFields(saved)} 个字段。`, "success", 0);
  return saved;
}

async function commitParsedResult(mode) {
  const pending = popupState.pendingParsed;

  if (!pending) {
    return;
  }

  try {
    if (mode === "update") {
      await saveParsedIntoActiveEntry(pending.groups, pending.currentId);
    } else {
      await saveParsedAsNew(pending.groups, pending.name);
    }

    popupState.pendingParsed = null;
    hideParseSaveConfirm();
    updateParseFileSelection(null);
  } catch (error) {
    showParseStatus(error.message || "保存失败。", "error", 0);
  }
}

function discardParsedResult() {
  popupState.pendingParsed = null;
  hideParseSaveConfirm();
  showParseStatus("解析结果没有保存。可以点「下载 Excel 核对」，或重新选文件再解析。", "warning", 0);
}

async function buildResumeParsePayload(file, extension) {
  if (extension === "txt") {
    return {
      fileType: "text",
      content: await readFileAsText(file)
    };
  }

  if (extension === "docx") {
    if (typeof mammoth === "undefined") {
      throw new Error("未找到 mammoth 解析库。");
    }

    const arrayBuffer = await readFileAsArrayBuffer(file, "读取 Word 文件失败。");
    const result = await mammoth.convertToHtml({ arrayBuffer });
    const textContent = extractTextFromHtml(result.value);

    if (!textContent.trim()) {
      throw new Error("Word 文件未解析到有效文本。");
    }

    return {
      fileType: "text",
      content: textContent
    };
  }

  if (extension === "pdf") {
    let pdfjsLib;
    let textContent;

    try {
      pdfjsLib = await loadPdfJs();
    } catch {
      throw new Error("PDF 解析组件加载失败，请在扩展管理页重新加载后重试。");
    }

    const arrayBuffer = await readFileAsArrayBuffer(file, "读取 PDF 文件失败。");

    try {
      textContent = await ResumeProUtils.extractPdfText(pdfjsLib, arrayBuffer, {
        cMapPacked: true,
        cMapUrl: chrome.runtime.getURL("vendor/pdfjs/cmaps/")
      });
    } catch (error) {
      throw new Error(ResumeProUtils.getPdfExtractionErrorMessage(error));
    }

    if (!textContent.trim()) {
      throw new Error(
        "PDF 未检测到可提取文字，可能是扫描版。请改用 Word / TXT、先用 OCR，或将页面转成图片后交给视觉模型。"
      );
    }

    return {
      fileType: "text",
      content: textContent
    };
  }

  throw new Error("暂不支持该文件类型。");
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取 TXT 文件失败。"));
    reader.readAsText(file);
  });
}

function readFileAsArrayBuffer(file, errorMessage) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(errorMessage));
    reader.readAsArrayBuffer(file);
  });
}

async function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import(chrome.runtime.getURL("vendor/pdfjs/pdf.min.mjs"))
      .then((pdfjsLib) => {
        pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");
        return pdfjsLib;
      });
  }

  return pdfJsPromise;
}

function extractTextFromHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html || "", "text/html");
  return (doc.body?.textContent || "").replace(/\s+\n/g, "\n").trim();
}

function normalizeParsedResult(fields) {
  const rawFields = Array.isArray(fields)
    ? fields
        .map((field) => ({
          group: String(field?.group ?? "").trim(),
          key: String(field?.key ?? "").trim(),
          value: String(field?.value ?? "")
        }))
        .filter((field) => field.group && field.key)
    : [];

  const normalizedFields = typeof self.ResumeProAIHelpers?.normalizeParsedFields === "function"
    ? self.ResumeProAIHelpers.normalizeParsedFields(rawFields)
    : rawFields;

  if (!normalizedFields.length) {
    throw new Error("AI 未能提取到有效信息，请检查文件内容。");
  }

  return normalizedFields;
}

// 和 parseTemplateFile 读 Excel 得到的结构一样，存进去的我的信息与「下载 Excel 再导入」一致。
function parsedFieldsToGroups(fields) {
  const groupMap = new Map();

  fields.forEach((field) => {
    if (!groupMap.has(field.group)) {
      groupMap.set(field.group, []);
    }

    groupMap.get(field.group).push({ key: field.key, value: field.value });
  });

  return Array.from(groupMap, ([name, groupFields]) => ({ name, fields: groupFields }));
}

function handleParseDownloadClick() {
  try {
    generateAndDownloadExcel(popupState.lastParsedFields);
    showParseStatus("Excel 已下载。", "success");
  } catch (error) {
    showParseStatus(error.message || "Excel 导出失败。", "error", 0);
  }
}

function generateAndDownloadExcel(fields) {
  const rows = [
    [...TEMPLATE_SHEET_HEADER],
    ...normalizeParsedResult(fields).map((field) => [field.group, field.key, field.value])
  ];

  BackupIO.saveWorkbook(rows, `resume_parsed_${formatCurrentDate()}.xlsx`);
}

function formatCurrentDate() {
  return formatDate(new Date());
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function showParseStatus(message, variant, autoHideDelay = 2200) {
  if (!elements.parseStatus) {
    return;
  }

  elements.parseStatus.textContent = message;
  elements.parseStatus.className = `status-message is-visible is-${variant}`;

  if (popupState.statusTimers.parse) {
    clearTimeout(popupState.statusTimers.parse);
  }

  if (autoHideDelay > 0) {
    popupState.statusTimers.parse = setTimeout(() => {
      elements.parseStatus.className = "status-message";
      elements.parseStatus.textContent = "";
    }, autoHideDelay);
  }
}

if (typeof self !== "undefined" && self.__RESUME_PRO_TEST__) {
  self.ResumeProTemplateImportTest = {
    cacheElements,
    cacheParseElements,
    countTemplateFields,
    createNewEntry,
    handleFileSelection,
    handleParseDownloadClick,
    handleParseResumeClick,
    handleTemplateListClick,
    parseTemplateFile,
    popupState,
    resolveTemplateName,
    StorageService,
    updateParseFileSelection,
    parsed: {
      commitParsedResult,
      discardParsedResult,
      hideParseSaveConfirm,
      saveParsedAsNew,
      saveParsedIntoActiveEntry,
      showParseSaveConfirm
    },
    rename: {
      commitRename,
      hideRenameRow,
      showRenameRow
    },
    profileScope: {
      commitProfileRename,
      createNewEntry,
      handleProfileDirectionChange,
      hideProfileRenameEditor,
      renderProfileScope,
      showProfileRenameEditor
    },
    profile: {
      applyTabFromHash,
      handleProfileDirectionChange,
      renderProfile,
      renderProfileScope,
      saveProfile,
      stripProfileSecrets
    },
    backup: {
      applyBackup,
      BackupIO,
      buildBackup,
      commitPendingBackup,
      exportBackup,
      handleBackupFileSelection,
      handleExportBackup,
      parseBackup,
      templateExportFileName,
      templateToSheetRows
    }
  };
}
