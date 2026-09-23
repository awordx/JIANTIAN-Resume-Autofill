const test = require("node:test");
const assert = require("node:assert/strict");

const helpers = require("../ai-helpers.js");
const { HEADER, loadPopup, makeFile } = require("./helpers/popup-harness.js");

class FakeFileReader {
  readAsText(file) {
    Promise.resolve(file.content).then((text) => {
      this.result = text;
      this.onload();
    });
  }
}

function parsePopup(reply) {
  const sent = [];
  const popup = loadPopup({
    globals: {
      FileReader: FakeFileReader,
      ResumeProAIHelpers: helpers,
      ResumeProAIClient: {
        send: async (message) => {
          sent.push(message);
          return reply;
        }
      }
    }
  });
  popup.api.cacheParseElements();
  return { popup, sent };
}

async function seed(popup) {
  await popup.importFile(makeFile("简历.xlsx", [HEADER, ["基本信息", "姓名", "张三"]]));
  const state = await popup.readState();
  state.aiConfig = { apiUrl: "https://api.example.com/v1/chat/completions", model: "m", apiKey: "sk" };
  await popup.writeState(state);
  popup.setCalls.length = 0;
}

test("opening the settings page leaves existing data and unrelated keys alone", async () => {
  const popup = loadPopup();
  await seed(popup);
  popup.store.resumeProUpdateCache = { checkedAt: 1 };

  await popup.api.StorageService.ensureDefaults();

  assert.deepEqual(popup.setCalls, []);
  assert.deepEqual(popup.store.resumeProUpdateCache, { checkedAt: 1 });
});

test("a fresh install only gets the missing defaults written", async () => {
  const popup = loadPopup();
  popup.store.aiConfig = { apiUrl: "https://relay.example/v1/chat/completions", model: "x", apiKey: "k" };

  const state = await popup.api.StorageService.ensureDefaults();

  assert.deepEqual(JSON.parse(JSON.stringify(popup.setCalls)), [["templates", "activeTemplateId", "profile"]]);
  assert.equal(popup.store.aiConfig.apiUrl, "https://relay.example/v1/chat/completions");
  assert.equal(state.aiConfig.model, "x");
});

test("switching template writes only activeTemplateId", async () => {
  const popup = loadPopup();
  await seed(popup);
  await popup.importFile(makeFile("第二份.xlsx", [HEADER, ["基本信息", "姓名", "李四"]]));
  const { templates } = await popup.readState();
  popup.setCalls.length = 0;

  await popup.api.StorageService.setActiveTemplate(templates[1].id);

  assert.deepEqual(popup.setCalls, [["activeTemplateId"]]);
});

test("基础信息页可以直接新建一份空的我的信息", async () => {
  const popup = loadPopup();

  await popup.api.createNewEntry("empty");

  const state = await popup.readState();
  assert.equal(state.templates.length, 1);
  assert.equal(state.activeTemplateId, state.templates[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(state.templates[0].profile)), {
    values: {}, education: [], family: [], custom: [], extraGroups: {}
  });
});

test("基础信息页可以复制当前我的信息，再独立修改副本", async () => {
  const popup = loadPopup();
  await seed(popup);
  await popup.api.profile.saveProfile({
    values: { name: "张三" },
    education: [{ school: "某大学" }],
    family: [],
    custom: []
  });

  const before = await popup.readState();
  const original = structuredClone(before.templates[0]);
  await popup.api.createNewEntry("copy");

  let state = await popup.readState();
  assert.equal(state.templates.length, 2);
  const copy = state.templates.find((item) => item.id === state.activeTemplateId);
  assert.match(copy.name, /副本/);
  assert.notEqual(copy.id, original.id);
  assert.deepEqual(JSON.parse(JSON.stringify(copy.groups)), JSON.parse(JSON.stringify(original.groups)));
  assert.deepEqual(JSON.parse(JSON.stringify(copy.profile)), JSON.parse(JSON.stringify(original.profile)));

  await popup.api.profile.saveProfile({ values: { name: "李四" }, education: [], family: [], custom: [] });
  state = await popup.readState();
  assert.equal(state.templates.find((item) => item.id === original.id).profile.values.name, "张三");
  assert.equal(state.templates.find((item) => item.id === copy.id).profile.values.name, "李四");
});

test("基础信息页可以直接重命名当前我的信息", async () => {
  const popup = loadPopup();
  await seed(popup);
  const state = await popup.readState();
  const entryId = state.activeTemplateId;

  popup.api.rename.showRenameRow(entryId, "原名称");
  popup.element("rename-input").value = "硬件方向";
  await popup.api.rename.commitRename();

  const renamed = await popup.readState();
  assert.equal(renamed.templates.find((item) => item.id === entryId).name, "硬件方向");
  assert.match(popup.lastStatusFrom("template-status"), /已改名为/);
});

test("a template change does not write back a stale AI config", async () => {
  const popup = loadPopup();
  await seed(popup);
  const { templates } = await popup.readState();

  await popup.api.StorageService.update((draft) => {
    popup.store.aiConfig = { apiUrl: "https://new.example/v1/chat/completions", model: "new", apiKey: "sk-new" };
    draft.templates = draft.templates.filter((template) => template.id !== templates[0].id);
    return draft;
  });

  assert.equal(popup.store.aiConfig.model, "new");
  assert.ok(popup.setCalls.every((keys) => !keys.includes("aiConfig")));
});

test("saving the AI config writes only aiConfig", async () => {
  const popup = loadPopup();
  await seed(popup);

  await popup.api.StorageService.saveAiConfig({ apiUrl: "https://api.example.com/v1/chat/completions", model: "m2", apiKey: "sk" });

  assert.deepEqual(popup.setCalls, [["aiConfig"]]);
});

test("a parsed resume asks whether to add a new 我的信息 or update the current one", async () => {
  const { popup, sent } = parsePopup({
    success: true,
    fields: [
      { group: "基本信息", key: "姓名", value: "王五" },
      { group: "基本信息", key: "手机", value: "13800000000" },
      { group: "教育背景", key: "学校", value: "某某大学" }
    ]
  });
  await seed(popup);
  popup.api.popupState.selectedParseFile = { name: "王五简历.txt", content: "王五 13800000000 某某大学" };

  await popup.api.handleParseResumeClick();

  assert.equal(sent.length, 1);
  // 已经有一份我的信息：先不落盘，等用户在「新建 / 更新当前」里选。
  let state = await popup.readState();
  assert.equal(state.templates.length, 1, "选之前不落盘");
  assert.match(popup.lastStatusFrom("parse-status"), /解析完成，共 3 个字段/);
  assert.equal(popup.element("parse-save-confirm").hidden, false);
  assert.equal(popup.element("parse-download-button").hidden, false, "Excel 核对随时可下载");
  assert.equal(popup.api.popupState.pendingParsed.groups.length, 2);

  const saved = [];
  popup.api.backup.BackupIO.saveWorkbook = (rows) => saved.push(rows);
  popup.api.handleParseDownloadClick();
  assert.equal(saved[0].length, 4);

  await popup.api.parsed.commitParsedResult("new");

  state = await popup.readState();
  assert.equal(state.templates.length, 2, "the existing one is kept");
  const added = state.templates.find((item) => item.name === "王五简历（AI 解析）");
  assert.ok(added, "新的一份用文件名命名");
  assert.equal(state.activeTemplateId, added.id);
  assert.deepEqual(JSON.parse(JSON.stringify(added.groups)), [
    { name: "基本信息", fields: [{ key: "姓名", value: "王五" }, { key: "手机", value: "13800000000" }] },
    { name: "教育背景", fields: [{ key: "学校", value: "某某大学" }] }
  ]);
  assert.match(popup.lastStatusFrom("parse-status"), /已存成新的一份「王五简历（AI 解析）」并设为当前，共 3 个字段/);
  assert.equal(popup.element("parse-save-confirm").hidden, true);
  assert.equal(popup.api.popupState.pendingParsed, null);

  popup.api.updateParseFileSelection({ name: "另一份.txt", content: "" });
  assert.equal(popup.element("parse-download-button").hidden, true, "a new file hides the previous resume's download");
});

test("更新当前这份 keeps the name the user gave that direction", async () => {
  const { popup } = parsePopup({ success: true, fields: [{ group: "技能", key: "技能1", value: "Verilog" }] });
  await seed(popup);

  let state = await popup.readState();
  const currentId = state.activeTemplateId;

  await popup.api.rename.showRenameRow(currentId, "简历");
  popup.element("rename-input").value = "硬件方向";
  await popup.api.rename.commitRename();

  state = await popup.readState();
  assert.equal(state.templates.find((item) => item.id === currentId).name, "硬件方向");

  popup.api.popupState.selectedParseFile = { name: "硬件版.txt", content: "Verilog" };
  await popup.api.handleParseResumeClick();
  await popup.api.parsed.commitParsedResult("update");

  state = await popup.readState();
  assert.equal(state.templates.length, 1, "更新不新增一份");
  const updated = state.templates.find((item) => item.id === currentId);
  assert.equal(updated.name, "硬件方向", "名字保留（用户就是靠它认方向）");
  assert.deepEqual(JSON.parse(JSON.stringify(updated.groups)), [
    { name: "技能", fields: [{ key: "技能1", value: "Verilog" }] }
  ]);
  assert.match(popup.lastStatusFrom("parse-status"), /已更新当前这份「硬件方向」并设为当前，共 1 个字段/);
});

test("第一份我的信息解析完直接存下，不用多问一次", async () => {
  const { popup } = parsePopup({ success: true, fields: [{ group: "技能", key: "技能1", value: "Verilog" }] });
  // 空插件：有 AI 配置但一份我的信息都没有
  await popup.api.StorageService.saveAiConfig({ apiUrl: "https://api.example.com/v1/chat/completions", model: "m", apiKey: "k" });
  popup.api.popupState.selectedParseFile = { name: "简历.txt", content: "Verilog" };

  await popup.api.handleParseResumeClick();

  const state = await popup.readState();
  assert.equal(state.templates.length, 1);
  assert.equal(state.templates[0].name, "简历（AI 解析）");
  assert.match(popup.lastStatusFrom("parse-status"), /已存成新的一份「简历（AI 解析）」并设为当前/);
});

test("先不保存：解析结果不落盘，并说清楚还能下载 Excel", async () => {
  const { popup } = parsePopup({ success: true, fields: [{ group: "技能", key: "技能1", value: "Verilog" }] });
  await seed(popup);
  popup.api.popupState.selectedParseFile = { name: "简历2.txt", content: "Verilog" };

  await popup.api.handleParseResumeClick();
  popup.api.parsed.discardParsedResult();

  const state = await popup.readState();
  assert.equal(state.templates.length, 1);
  assert.equal(popup.api.popupState.pendingParsed, null);
  assert.match(popup.lastStatusFrom("parse-status"), /解析结果没有保存/);
});

test("改名只说名字，不动里面的字段", async () => {
  const popup = loadPopup();
  await seed(popup);
  const state = await popup.readState();
  const id = state.activeTemplateId;
  const groupsBefore = JSON.stringify(state.templates[0].groups);

  await popup.api.rename.showRenameRow(id, "简历");
  assert.equal(popup.api.popupState.renamingId, id);
  assert.equal(popup.element("rename-confirm").hidden, false);

  popup.element("rename-input").value = "软件方向";
  await popup.api.rename.commitRename();

  const after = await popup.readState();
  assert.equal(after.templates[0].name, "软件方向");
  assert.equal(JSON.stringify(after.templates[0].groups), groupsBefore);
  assert.equal(popup.element("rename-confirm").hidden, true);
  assert.match(popup.lastStatusFrom("template-status"), /已改名为「软件方向」/);
});

test("空名字不覆盖原来的名字", async () => {
  const popup = loadPopup();
  await seed(popup);
  const state = await popup.readState();
  const id = state.activeTemplateId;

  await popup.api.rename.showRenameRow(id, "简历");
  popup.element("rename-input").value = "   ";
  await popup.api.rename.commitRename();

  const after = await popup.readState();
  assert.equal(after.templates[0].name, "简历", "空名字被拒绝");
  assert.match(popup.lastStatusFrom("template-status"), /名字不能为空/);
});

test("a failed parse stores nothing", async () => {
  const { popup } = parsePopup({ success: false, error: "AI 接口请求失败" });
  await seed(popup);
  popup.api.popupState.selectedParseFile = { name: "简历.txt", content: "内容" };

  await popup.api.handleParseResumeClick();

  assert.equal((await popup.readState()).templates.length, 1);
  assert.deepEqual(popup.setCalls, []);
  assert.equal(popup.element("parse-download-button").hidden, true);
});
