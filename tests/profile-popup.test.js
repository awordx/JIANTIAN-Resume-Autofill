const test = require("node:test");
const assert = require("node:assert/strict");

const { HEADER, loadPopup: loadPopupRaw, makeFile, makeTextFile } = require("./helpers/popup-harness.js");

let secretFields;

test.before(async () => {
  secretFields = await import("../link/secret-fields.mjs");
});

function loadPopup() {
  const popup = loadPopupRaw({ globals: { ResumeProSecretFields: secretFields } });
  const saved = [];
  popup.api.backup.BackupIO.saveJson = (fileName, data) => saved.push(JSON.parse(JSON.stringify(data)));
  return { popup, saved };
}

async function seedTemplate(popup) {
  await popup.importFile(makeFile("简历.xlsx", [HEADER, ["基本信息", "姓名", "模板里的张三"]]));
}

async function restore(popup, backup, mode) {
  await popup.api.backup.handleBackupFileSelection({
    target: { files: [makeTextFile("backup.json", JSON.stringify(backup))] }
  });
  if (mode) await popup.api.backup.commitPendingBackup(mode);
  return popup.readState();
}

test("saving 基础信息 writes it into the current 我的信息 and says what is still empty", async () => {
  const { popup } = loadPopup();
  await seedTemplate(popup);
  popup.setCalls.length = 0;

  await popup.api.profile.saveProfile({
    values: { name: "张三" },
    family: [],
    custom: [{ key: "是否有亲属在本行工作", value: "" }]
  });

  // 基础信息是按方向各存一份的：保存只落在当前那一份里，不写全局那份。
  assert.deepEqual(JSON.parse(JSON.stringify(popup.setCalls)), [["templates"]]);
  const state = await popup.readState();
  assert.equal(state.templates.length, 1);
  assert.equal(state.templates[0].profile.values.name, "张三");
  assert.deepEqual(JSON.parse(JSON.stringify(state.profile.values)), {}, "全局那份不再被写");
  assert.match(popup.lastStatusFrom("profile-status"), /已保存 1 项，还有 1 个字段没填内容/);
});

test("saving 基础信息 with no 我的信息 creates a visible current record", async () => {
  const { popup } = loadPopup();
  await popup.api.StorageService.ensureDefaults();
  await popup.api.profile.saveProfile({ values: { name: "张三", phone: "13800000000" }, education: [], family: [], custom: [] });

  const state = await popup.readState();
  assert.equal(state.templates.length, 1);
  assert.equal(state.activeTemplateId, state.templates[0].id);
  assert.equal(state.templates[0].profile.values.name, "张三");
  assert.match(popup.element("template-list").innerHTML, /张三/);
  assert.doesNotMatch(popup.element("template-list").innerHTML, /还没有我的信息/);
});

test("previously saved profile-only data becomes a visible record on opening", async () => {
  const { popup } = loadPopup();
  const initial = await popup.api.StorageService.ensureDefaults();
  await popup.writeState({ ...initial, templates: [], activeTemplateId: "", profile: { values: { name: "11" } } });
  const state = await popup.api.StorageService.ensureProfileRecord();
  assert.equal(state.templates.length, 1);
  assert.equal(state.templates[0].profile.values.name, "11");
  assert.equal(state.activeTemplateId, state.templates[0].id);
  const reopened = await popup.api.StorageService.ensureProfileRecord();
  assert.equal(reopened.templates.length, 1, "migration happens only once");
});

test("a fresh install also gets an empty profile written", async () => {
  const { popup } = loadPopup();

  await popup.api.StorageService.ensureDefaults();

  assert.ok(popup.setCalls[0].includes("profile"));
  assert.deepEqual(JSON.parse(JSON.stringify(popup.store.profile)), { values: {}, education: [], family: [], custom: [] });
});

test("backups carry 我的信息, minus anything that looks like a password", async () => {
  const { popup, saved } = loadPopup();
  await seedTemplate(popup);
  await popup.api.profile.saveProfile({
    values: { name: "张三", ethnicity: "汉族" },
    family: [{ relation: "父亲", name: "张父", job: "网银密码：hunter3" }],
    custom: [{ key: "网银登录密码", value: "hunter2" }, { key: "职业规划", value: "银行" }]
  });

  await popup.api.backup.handleExportBackup();

  assert.equal(saved.length, 1);
  const backup = saved[0];
  assert.equal(backup.formatVersion, 2, "a backup carrying 我的信息 tells older plugins to update instead of dropping it");
  const entry = backup.templates[0];
  assert.equal(entry.profile.values.ethnicity, "汉族");
  assert.equal(entry.profile.family[0].name, "张父");
  assert.equal(entry.profile.family[0].job, "");
  assert.deepEqual(entry.profile.custom, [{ key: "职业规划", value: "银行" }]);
  assert.doesNotMatch(JSON.stringify(backup), /hunter2|hunter3/);
  assert.match(popup.lastStatusFrom("backup-status"), /已导出 1 份我的信息和基础信息，跳过 2 个/);
});

test("a profile-only 我的信息 stays visible after backup and restore", async () => {
  const { popup, saved } = loadPopup();
  await popup.api.profile.saveProfile({ values: { name: "张三" }, family: [], custom: [] });

  await popup.api.backup.handleExportBackup();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].templates.length, 1);
  assert.equal(saved[0].templates[0].profile.values.name, "张三");

  const { popup: fresh } = loadPopup();
  const state = await restore(fresh, saved[0]);
  assert.equal(state.templates.length, 1);
  assert.equal(state.templates[0].profile.values.name, "张三");
  assert.match(fresh.element("template-list").innerHTML, /张三/);
});

test("replacing with a profile-only backup keeps this machine's templates", async () => {
  const { popup } = loadPopup();
  await seedTemplate(popup);
  const before = await popup.readState();

  const state = await restore(popup, {
    format: "resume-pro.backup",
    formatVersion: 1,
    templates: [],
    profile: { values: { name: "备份里的张三" } }
  }, "replace");

  assert.equal(state.templates.length, 1);
  assert.equal(state.activeTemplateId, before.activeTemplateId);
  assert.equal(state.profile.values.name, "备份里的张三");
});

test("appending a backup only fills in what 我的信息 is missing", async () => {
  const { popup } = loadPopup();
  await seedTemplate(popup);
  await popup.api.profile.saveProfile({ values: { name: "本机" }, family: [], custom: [] });

  const state = await restore(popup, {
    format: "resume-pro.backup",
    formatVersion: 1,
    templates: [],
    profile: { values: { name: "备份", ethnicity: "汉族" } }
  }, "append");

  // 本机那份我的信息（连同它的基础信息）不动；备份里的基础信息进全局那份，供新建方向继承。
  assert.equal(state.templates[0].profile.values.name, "本机");
  assert.equal(state.profile.values.name, "备份");
  assert.equal(state.profile.values.ethnicity, "汉族");
});

test("backup format: template-only stays version 1, versions 1 and 2 import, newer ones are refused", async () => {
  const { popup, saved } = loadPopup();
  await seedTemplate(popup);
  await popup.api.backup.handleExportBackup();
  assert.equal(saved[0].formatVersion, 1, "older plugins can still restore a backup with no 我的信息");

  const { popup: fresh } = loadPopup();
  const state = await restore(fresh, {
    format: "resume-pro.backup",
    formatVersion: 2,
    templates: [],
    profile: { values: { name: "张三" } }
  });
  assert.equal(state.profile.values.name, "张三");

  const { popup: another } = loadPopup();
  await restore(another, { format: "resume-pro.backup", formatVersion: 3, templates: [], profile: { values: { name: "张三" } } });
  assert.match(another.lastStatusFrom("backup-status"), /更新/);
});

test("an older backup without 基础信息 does not write anything into the local 基础信息", async () => {
  const { popup } = loadPopup();
  await seedTemplate(popup);
  await popup.api.profile.saveProfile({ values: { name: "本机" }, family: [], custom: [] });

  const state = await restore(popup, {
    format: "resume-pro.backup",
    formatVersion: 1,
    templates: [{ id: "old", name: "旧模板", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "王五" }] }] }]
  }, "replace");

  assert.deepEqual(state.templates.map((template) => template.name), ["旧模板"]);
  // 备份没带基础信息：全局那份保持不动；被替换掉的那份我的信息随之消失（替换就是替换）。
  assert.deepEqual(JSON.parse(JSON.stringify(state.profile.values)), {});
  assert.equal(state.templates[0].profile.values.name, undefined);
});


test("每份我的信息各存各的基础信息，新方向只接收解析结果中明确提供的字段", async () => {
  const { popup } = loadPopup();
  await seedTemplate(popup);
  let state = await popup.readState();
  const firstId = state.templates[0].id;

  await popup.api.profile.saveProfile({ values: { name: "硬件方向的人" }, family: [], custom: [] });

  // 解析新建一份新方向：应该继承当前这份的基础信息（同一个人，只是投别的方向）
  await popup.api.parsed.saveParsedAsNew(
    [{ name: "技能", fields: [{ key: "技能1", value: "Python" }] }],
    "软件方向（AI 解析）"
  );

  state = await popup.readState();
  assert.equal(state.templates.length, 2);
  const second = state.templates.find((entry) => entry.name === "软件方向（AI 解析）");
  assert.ok(second, "新那份在列表里");
  assert.equal(second.profile.values.name, undefined, "解析结果未提供姓名时保持为空");
  assert.equal(state.activeTemplateId, second.id, "新建的自动设为当前");

  // 在新那份里改基础信息
  await popup.api.profile.saveProfile({ values: { name: "软件方向的人" }, family: [], custom: [] });

  state = await popup.readState();
  assert.equal(
    state.templates.find((entry) => entry.id === second.id).profile.values.name,
    "软件方向的人",
    "改的是新那份"
  );
  assert.equal(
    state.templates.find((entry) => entry.id === firstId).profile.values.name,
    "硬件方向的人",
    "原来那份没被动"
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(state.profile.values)),
    {},
    "全局那份保持空着（只给还没写过基础信息的条目当初始值）"
  );
});

test("基础信息有未保存的改动时不切方向，避免把改动丢了", async () => {
  const { popup } = loadPopup();
  await seedTemplate(popup);
  let state = await popup.readState();
  const firstId = state.templates[0].id;
  await popup.api.parsed.saveParsedAsNew([{ name: "技能", fields: [{ key: "技能1", value: "X" }] }], "第二份");

  state = await popup.readState();
  const secondId = state.activeTemplateId;
  assert.notEqual(secondId, firstId);

  popup.api.popupState.profileDirty = true;
  popup.element("profile-direction-select").value = firstId;
  await popup.api.profile.handleProfileDirectionChange();

  state = await popup.readState();
  assert.equal(state.activeTemplateId, secondId, "还没保存，不切");
  assert.match(popup.lastStatusFrom("profile-status"), /先点「保存」再切方向/);

  popup.api.popupState.profileDirty = false;
  popup.element("profile-direction-select").value = firstId;
  await popup.api.profile.handleProfileDirectionChange();

  state = await popup.readState();
  assert.equal(state.activeTemplateId, firstId, "保存后可以切");
  assert.match(popup.lastStatusFrom("profile-status"), /正在编辑「/);
});
