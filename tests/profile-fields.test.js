const test = require("node:test");
const assert = require("node:assert/strict");

const profileApi = require("../profile-fields.js");
const helpers = require("../ai-helpers.js");

test("解析简历字段可以作为新建档案的基础信息初始值", () => {
  const profile = profileApi.profileFromResumeFields(
    { values: { name: "旧姓名", phone: "旧电话" }, education: [], family: [], custom: [] },
    [{ name: "基本信息", fields: [
      { key: "姓名", value: "王小明" },
      { key: "手机", value: "13800000000" },
      { key: "邮箱", value: "example.user@example.com" }
    ] }]
  );

  assert.equal(profile.values.name, "王小明");
  assert.equal(profile.values.phone, "13800000000");
  assert.equal(profile.values.email, "example.user@example.com");
});
test("解析简历字段会写入教育经历记录", () => {
  const profile = profileApi.profileFromResumeFields({}, [
    { name: "教育经历", fields: [
      { key: "学校", value: "华北理工大学" },
      { key: "专业", value: "控制科学与工程" },
      { key: "学历", value: "硕士研究生" },
      { key: "开始时间", value: "2023-09-01" },
      { key: "结束时间", value: "2026-06-01" }
    ] }
  ]);

  assert.equal(profile.education.length, 1);
  assert.equal(profile.education[0].schoolName, "华北理工大学");
  assert.equal(profile.education[0].majorName, "控制科学与工程");
  assert.equal(profile.education[0].eduLevel, "硕士研究生");
});
test("解析简历字段缺失的基础信息保持为空，不继承旧档案", () => {
  const profile = profileApi.profileFromResumeFields(
    { values: { name: "旧姓名", phone: "旧电话", ethnicity: "汉族" }, education: [], family: [], custom: [] },
    [{ name: "基本信息", fields: [{ key: "姓名", value: "王小明" }] }]
  );

  assert.deepEqual(profile.values, { name: "王小明" });
});

test("normalizeProfile drops blanks and empty members, keeps pending custom fields once", () => {
  const profile = profileApi.normalizeProfile({
    values: { name: " 张三 ", usedName: "   " },
    family: [
      { relation: "父亲", name: "张父" },
      { relation: "表哥", name: "张表" },
      { relation: "母亲", name: "" }
    ],
    custom: [
      { key: "是否有亲属在本行", value: "" },
      { key: "是否有亲属在本行 ", value: "否" },
      { key: "  ", value: "x" }
    ]
  });

  assert.deepEqual(profile.values, { name: "张三" });
  assert.deepEqual(profile.family.map((member) => [member.relation, member.name]), [["父亲", "张父"], ["其他亲属", "张表"]]);
  assert.deepEqual(profile.custom, [{ key: "是否有亲属在本行", value: "否" }], "the filled duplicate wins over the empty one");
  assert.deepEqual(profileApi.normalizeProfile(null), profileApi.emptyProfile());
});

test("PROFILE_SCHEMA 含有合并后的基本信息和工作经历", () => {
  assert.equal(profileApi.PROFILE_SCHEMA.find((group) => group.name === "户籍与地区"), undefined);
  assert.ok(profileApi.PROFILE_SCHEMA.find((group) => group.name === "工作经历").fields.some((field) => field.key === "工作成果"));
});
test("基础信息表单保存会保留新增分组记录", () => {
  const profile = profileApi.profileFromEntries([
    { kind: "extra", group: "campus", row: "1", field: "startTime", value: "2024-09-01" },
    { kind: "extra", group: "campus", row: "1", field: "experienceType", value: "社团组织" },
    { kind: "extra", group: "campus", row: "1", field: "position", value: "部长" },
    { kind: "extra", group: "projects", row: "2", field: "name", value: "项目甲" }
  ]);

  assert.equal(profile.extraGroups.campus[0].experienceType, "社团组织");
  assert.equal(profile.extraGroups.campus[0].position, "部长");
  assert.equal(profile.extraGroups.projects[0].name, "项目甲");
});
test("profile fields: presets, numbered repeat relations, filled custom fields only", () => {
  const fields = profileApi.profileToResumeFields({
    values: { name: "张三", nativeProvince: "河南省" },
    family: [
      { relation: "父亲", name: "张父", company: "某公司" },
      { relation: "兄弟姐妹", name: "张一" },
      { relation: "兄弟姐妹", name: "张二" }
    ],
    custom: [{ key: "英语口语", value: "流利" }, { key: "待补字段", value: "" }]
  });

  assert.deepEqual(fields, [
    { group: "基本信息", key: "姓名", value: "张三" },
    { group: "基本信息", key: "籍贯省", value: "河南省" },
    { group: "家庭主要成员", key: "父亲关系", value: "父亲" },
    { group: "家庭主要成员", key: "父亲姓名", value: "张父" },
    { group: "家庭主要成员", key: "父亲工作单位", value: "某公司" },
    { group: "家庭主要成员", key: "兄弟姐妹1关系", value: "兄弟姐妹" },
    { group: "家庭主要成员", key: "兄弟姐妹1姓名", value: "张一" },
    { group: "家庭主要成员", key: "兄弟姐妹2关系", value: "兄弟姐妹" },
    { group: "家庭主要成员", key: "兄弟姐妹2姓名", value: "张二" },
    { group: "补充字段", key: "英语口语", value: "流利" }
  ]);
  assert.equal(profileApi.countPendingFields({ custom: [{ key: "待补字段", value: "" }] }), 1);
});

test("education records preserve multiple entries and emit each segment independently", () => {
  const profile = profileApi.normalizeProfile({
    education: [
      { schoolName: "甲大学", majorName: "自动化", startTime: "2019-09-01", endTime: "2023-06-30", eduLevel: "本科" },
      { schoolName: "乙大学", majorName: "控制科学", startTime: "2023-09-01", endTime: "2026-06-30", eduLevel: "硕士研究生", mentorName: "李老师" },
      { schoolName: "", majorName: "" }
    ]
  });

  assert.equal(profile.education.length, 2);
  assert.deepEqual(profileApi.profileToResumeFields(profile).filter((field) => field.group.startsWith("教育经历")), [
    { group: "教育经历1", key: "开始时间", value: "2019-09-01" },
    { group: "教育经历1", key: "结束时间", value: "2023-06-30" },
    { group: "教育经历1", key: "学历", value: "本科" },
    { group: "教育经历1", key: "学校", value: "甲大学" },
    { group: "教育经历1", key: "专业", value: "自动化" },
    { group: "教育经历2", key: "开始时间", value: "2023-09-01" },
    { group: "教育经历2", key: "结束时间", value: "2026-06-30" },
    { group: "教育经历2", key: "学历", value: "硕士研究生" },
    { group: "教育经历2", key: "学校", value: "乙大学" },
    { group: "教育经历2", key: "专业", value: "控制科学" },
    { group: "教育经历2", key: "导师姓名", value: "李老师" }
  ]);
});

test("legacy education overview migrates to one education record and no longer emits fixed overview fields", () => {
  const profile = profileApi.normalizeProfile({
    values: { highestEducation: "大学本科", schoolName: "甲大学", majorName: "自动化", admission: "2019-09-01", graduation: "2023-06-30" }
  });
  assert.deepEqual(profile.values, {});
  assert.deepEqual(profile.education.map((record) => [record.eduLevel, record.schoolName, record.majorName]), [["本科", "甲大学", "自动化"]]);
  assert.equal(profileApi.PROFILE_SCHEMA.some((group) => group.name === "教育概况"), false);
});

test("template fields win over profile fields with the same name", () => {
  const merged = profileApi.mergeResumeFields(
    [{ group: "基本信息", key: "姓名", value: "模板里的名字" }],
    [{ group: "基本信息", key: "姓名", value: "档案里的名字" }, { group: "基本信息", key: "民族", value: "汉族" }]
  );

  assert.deepEqual(merged.map((field) => field.value), ["模板里的名字", "汉族"]);
});

test("configured education records remain available when a template has same-named fields", () => {
  const profileFields = profileApi.profileToResumeFields({
    education: [{ schoolName: "甲大学", majorName: "自动化" }]
  });
  const merged = profileApi.mergeResumeFields(
    [{ group: "教育经历", key: "学校", value: "模板学校" }],
    profileFields
  );
  assert.ok(merged.some((field) => field.group === "教育经历1" && field.key === "学校" && field.value === "甲大学"));
});

test("unanswered labels skip matched, filled, secret, file and known fields", () => {
  const known = profileApi.knownFieldKeys({ custom: [{ key: "已加过的字段", value: "" }] }, [{ key: "毕业院校" }]);
  const labels = profileApi.pickUnansweredLabels([
    { label: "是否有亲属在本行工作", inputType: "select" },
    { label: "是否有亲属在本行工作", inputType: "select" },
    { label: "姓名", inputType: "text", matched: true },
    { label: "兴趣爱好", inputType: "text", hasValue: true },
    { label: "登录密码", inputType: "text" },
    { label: "短信验证码", inputType: "text" },
    { label: "本人照片", inputType: "file" },
    { label: "我已阅读并同意", inputType: "checkbox" },
    { label: "身高（厘米）", inputType: "text" },
    { label: "已加过的字段", inputType: "text" },
    { label: "毕业院校", inputType: "text" },
    { label: "问", inputType: "text" },
    { label: "这是一个非常非常非常非常非常非常非常非常非常长的说明文字字段标签内容", inputType: "textarea" },
    { label: "职业规划", inputType: "textarea" }
  ], known);

  assert.deepEqual(labels, ["是否有亲属在本行工作", "职业规划"]);
  assert.equal(profileApi.pickUnansweredLabels(
    Array.from({ length: 30 }, (_, index) => ({ label: `字段${index}`, inputType: "text" })),
    new Set()
  ).length, 20);
});

test("adding pending fields skips what the profile already has", () => {
  const { profile, added } = profileApi.addPendingFields(
    { values: { name: "张三" }, custom: [{ key: "英语口语", value: "流利" }] },
    ["英语口语", "英语口语", "职业规划", "职业规划"]
  );

  assert.equal(added, 1, "是否服从调剂 is a preset, 英语口语 exists, 职业规划 once");
  assert.deepEqual(profile.custom, [{ key: "英语口语", value: "流利" }, { key: "职业规划", value: "" }]);
  assert.equal(profile.values.name, "张三");
});

test("password-like custom fields and duplicates of presets never reach the AI field pool", () => {
  const fields = profileApi.profileToResumeFields({
    values: { phone: "13800000000" },
    custom: [
      { key: "网银登录密码", value: "hunter2" },
      { key: "备注", value: "网银密码：hunter3" },
      { key: "手机号码", value: "13900000000" },
      { key: "英语口语", value: "流利" }
    ]
  });

  assert.deepEqual(fields.map((field) => [field.key, field.value]), [["手机号码", "13800000000"], ["英语口语", "流利"]]);
});

test("known fields cover preset aliases and blank items of members already in the profile", () => {
  const known = profileApi.knownFieldKeys({ family: [{ relation: "父亲", name: "张父" }] }, []);
  const labels = profileApi.pickUnansweredLabels(
    ["手机号", "邮箱", "父亲联系电话", "父亲工作单位", "母亲工作单位"].map((label) => ({ label, inputType: "text" })),
    known
  );

  assert.deepEqual(labels, ["母亲工作单位"]);
});

test("adding pending fields skips password-like labels and says when the list is full", () => {
  assert.equal(profileApi.addPendingFields({}, ["查询密码"]).added, 0);

  const full = { custom: Array.from({ length: 200 }, (_, index) => ({ key: `字段${index}`, value: "" })) };
  const result = profileApi.addPendingFields(full, ["职业规划"]);
  assert.equal(result.added, 0);
  assert.equal(result.full, true);

  assert.equal(profileApi.addPendingFields({}, ["毕业院校"], [{ key: "毕业院校" }]).added, 0, "template fields count as known");
});

test("form entries round-trip into a profile", () => {
  const profile = profileApi.profileFromEntries([
    { kind: "value", field: "name", value: "张三" },
    { kind: "education", row: "2", field: "schoolName", value: "甲大学" },
    { kind: "education", row: "2", field: "majorName", value: "自动化" },
    { kind: "education", row: "5", field: "schoolName", value: "乙大学" },
    { kind: "family", row: "3", field: "relation", value: "母亲" },
    { kind: "family", row: "3", field: "name", value: "李母" },
    { kind: "family", row: "4", field: "relation", value: "父亲" },
    { kind: "custom", row: "7", field: "key", value: "英语口语" },
    { kind: "custom", row: "7", field: "value", value: "流利" }
  ]);

  assert.deepEqual(profile.values, { name: "张三" });
  assert.deepEqual(profile.education.map((record) => [record.schoolName, record.majorName]), [["甲大学", "自动化"], ["乙大学", ""]]);
  assert.deepEqual(profile.family.map((member) => [member.relation, member.name]), [["母亲", "李母"]]);
  assert.deepEqual(profile.custom, [{ key: "英语口语", value: "流利" }]);
});

test("merging a backup keeps what this machine already filled in", () => {
  const merged = profileApi.mergeProfiles(
    {
      values: { name: "本机" },
      family: [{ relation: "父亲", name: "本机父亲" }, { relation: "兄弟姐妹", name: "张一" }],
      custom: [{ key: "英语口语", value: "" }]
    },
    {
      values: { name: "备份", ethnicity: "汉族" },
      family: [
        { relation: "父亲", name: "备份父亲", company: "某公司" },
        { relation: "母亲", name: "备份母亲" },
        { relation: "兄弟姐妹", name: "张一", phone: "13900000000" },
        { relation: "兄弟姐妹", name: "张二" }
      ],
      custom: [{ key: "英语口语", value: "流利" }, { key: "职业规划", value: "银行" }]
    }
  );

  assert.deepEqual(merged.values, { name: "本机", ethnicity: "汉族" });
  assert.deepEqual(
    merged.family.map((member) => [member.relation, member.name, member.company, member.phone]),
    [
      ["父亲", "本机父亲", "某公司", ""],
      ["兄弟姐妹", "张一", "", "13900000000"],
      ["母亲", "备份母亲", "", ""],
      ["兄弟姐妹", "张二", "", ""]
    ],
    "members are merged one by one, filling only what this machine left blank"
  );
  assert.deepEqual(merged.custom, [{ key: "英语口语", value: "流利" }, { key: "职业规划", value: "银行" }]);
});

test("rules: profile region keys fill the right level and topic", () => {
  const resumeFields = profileApi.profileToResumeFields({
    values: { nativeProvince: "河南省", nativeCity: "南阳市", hukouCounty: "南召县", examProvince: "湖北省" }
  });
  const byId = new Map(helpers.buildRuleBasedMatches([
    { fieldId: "np", label: "籍贯", placeholder: "请选择省", inputType: "select", options: ["河南省"] },
    { fieldId: "nc", label: "籍贯", placeholder: "请选择市", inputType: "select", options: ["南阳市"] },
    { fieldId: "hk", label: "户口所在地", placeholder: "请选择区县", inputType: "select", options: ["南召县"] },
    { fieldId: "ex", label: "生源地", placeholder: "请选择省", inputType: "select", options: ["湖北省"] }
  ], resumeFields).map((match) => [match.fieldId, match.value]));

  assert.equal(byId.get("np"), "河南省");
  assert.equal(byId.get("nc"), "南阳市");
  assert.equal(byId.get("hk"), "南召县");
  assert.equal(byId.get("ex"), "湖北省");
});

test("rules: family and emergency contact data never fill the applicant's own fields", () => {
  const resumeFields = profileApi.profileToResumeFields({
    values: { emergencyName: "王五", emergencyPhone: "13700000000" },
    family: [{ relation: "兄弟姐妹", name: "张一", phone: "13900000000" }, { relation: "父亲", name: "张父" }]
  });
  const byId = new Map(helpers.buildRuleBasedMatches([
    { fieldId: "own-name", label: "姓名", inputType: "text", options: [] },
    { fieldId: "own-phone", label: "手机号码", inputType: "text", options: [] },
    { fieldId: "father", label: "姓名", group: "父亲", inputType: "text", options: [] },
    { fieldId: "emg-phone", label: "紧急联系人电话", inputType: "text", options: [] }
  ], resumeFields).map((match) => [match.fieldId, match.value]));

  assert.equal(byId.has("own-name"), false);
  assert.equal(byId.has("own-phone"), false);
  assert.equal(byId.get("father"), "张父");
  assert.equal(byId.get("emg-phone"), "13700000000");
});

// ---- 2026-09-19 第二轮：占位数据不得污染网申（真实配置回归） ----

test("isPlaceholderValue only flags text that cannot be real data", () => {
  for (const value of ["", "   ", "此处姓名", "此处工作单位", "某某公司", "示例大学", "样例", "请填写", "待填", "XXX", "xxx", "placeholder"]) {
    assert.equal(profileApi.isPlaceholderValue(value), true, `${value} 应判为占位`);
  }
  // 这些是合法数据，绝不能当成占位（项目自带测试也把 张三/李四 当普通姓名用）
  for (const value of ["王小明", "张三", "李四", "王五", "无", "华北理工大学", "清华大学", "很优秀", "应届毕业生"]) {
    assert.equal(profileApi.isPlaceholderValue(value), false, `${value} 不应判为占位`);
  }
});

test("normalizeProfile treats placeholder text as unfilled (real 某商业银行 profile)", () => {
  const profile = profileApi.normalizeProfile({
    values: {
      name: "李四",                       // 合法姓名，保留（由模板优先规则决定要不要用）
      awards: "此处奖励荣誉",
      currentAddress: "此处家庭住址",
      expectedCity: "此处期望工作地点",
      specialCategory: "此处专项招聘类别",
      skills: "此处技能特长",
      idNumber: "11010519491231002X",
      birth: "2003-01-16"
    },
    family: [{ relation: "兄弟姐妹", name: "此处姓名", company: "此处工作单位", job: "此处职务", phone: "此处联系电话", political: "此处政治面貌", birth: "2025-12-29" }],
    education: [{ eduLevel: "硕士研究生", schoolName: "清华大学", score: "3.9", graduationThesis: "毕业炉温", startTime: "2023-09-19" }],
    custom: [{ key: "工作年限", value: "0" }, { key: "自我评价", value: "此处自我评价" }]
  });

  assert.deepEqual(Object.keys(profile.values).sort(), ["birth", "idNumber", "name"]);
  assert.equal(profile.family[0].name, "");
  assert.equal(profile.family[0].company, "");
  assert.equal(profile.family[0].job, "");
  assert.equal(profile.family[0].birth, "2025-12-29", "真实值要留着");
  assert.equal(profile.education[0].schoolName, "清华大学", "非占位写法原样保留（是不是示例由模板优先规则处理）");
  assert.deepEqual(profile.custom, [{ key: "工作年限", value: "0" }, { key: "自我评价", value: "" }]);
});

test("mergeResumeFields: resume covers the same degree level, so its school/GPA/rank win over the半填充 profile", () => {
  const template = [
    { group: "基本信息", key: "姓名", value: "王小明" },
    { group: "教育背景", key: "华北理工大学教育经历-学校", value: "华北理工大学" },
    { group: "教育背景", key: "华北理工大学教育经历-专业", value: "控制科学与工程/硕士" },
    { group: "教育背景", key: "华北理工大学教育经历-时间", value: "2023.09—2026.06" },
    { group: "教育背景", key: "华北理工大学教育经历-主修课程", value: "矩阵论、最优化方法" },
    { group: "教育背景", key: "华北理工大学教育经历-论文情况", value: "发表SCI一区论文一篇" },
    { group: "教育背景", key: "华北理工大学教育经历-GPA", value: "3.56" },
    { group: "教育背景", key: "华北理工大学教育经历-排名", value: "6/86" },
    { group: "教育背景", key: "华北工业大学教育经历-学校", value: "华北工业大学" },
    { group: "教育背景", key: "华北工业大学教育经历-专业", value: "自动化/本科" },
    { group: "教育背景", key: "华北工业大学教育经历-时间", value: "2019.09—2023.06" },
    { group: "教育背景", key: "华北工业大学教育经历-GPA", value: "3.74" },
    { group: "教育背景", key: "华北工业大学教育经历-排名", value: "10/112" }
  ];
  const profile = profileApi.profileToResumeFields({
    values: { idNumber: "11010519491231002X" },
    education: [
      { eduLevel: "硕士研究生", schoolName: "清华大学", majorName: "控制科学与工程", score: "3.9", ranking: "前5%", graduationThesis: "毕业炉温", collegeName: "电气学院", studyForm: "全日制", startTime: "2023-09-19", endTime: "2026-06-19" },
      { eduLevel: "本科", schoolName: "清华大学", majorName: "自动化", score: "3.9", ranking: "前5%", studyForm: "全日制" }
    ]
  });
  const merged = profileApi.mergeResumeFields(template, profile);
  const values = merged.map((field) => field.value);

  // 模板提供的同层次字段：学校/GPA/排名/时间/课程/论文 都不再从档案带进来
  assert.equal(values.includes("清华大学"), false, "档案里的示例学校不得进入候选");
  assert.equal(values.includes("3.9"), false, "档案里的示例 GPA 不得进入候选");
  assert.equal(values.includes("前5%"), false, "档案里的示例排名不得进入候选");
  assert.equal(values.includes("毕业炉温"), false, "模板的论文情况已覆盖档案的毕业论文");
  assert.equal(values.includes("2023-09-19"), false, "时间由模板的时间区间给出");
  assert.ok(values.includes("3.56") && values.includes("3.74"), "模板 GPA 要在候选里");
  assert.ok(values.includes("华北理工大学") && values.includes("华北工业大学"));
  // 模板没有的字段仍然由档案补：学院/学习形式/学历
  assert.ok(values.includes("电气学院"), "学院（模板没有）要保留");
  assert.ok(values.includes("全日制"), "学习形式（模板没有）要保留");
  assert.ok(values.includes("硕士研究生"), "学历（模板没有）要保留");
  // 来源标记交给 AI 判断优先级
  assert.equal(merged.find((field) => field.key === "姓名").source, "template");
  assert.equal(merged.find((field) => field.key === "学院（院系）").source, "profile");
});

test("mergeResumeFields keeps a second profile degree the resume does not mention", () => {
  const template = [
    { group: "教育背景", key: "华北理工大学教育经历-专业", value: "控制科学与工程/硕士" },
    { group: "教育背景", key: "华北理工大学教育经历-学校", value: "华北理工大学" }
  ];
  const profile = profileApi.profileToResumeFields({
    education: [
      { eduLevel: "硕士研究生", schoolName: "清华大学", majorName: "控制科学与工程" },
      { eduLevel: "专科", schoolName: "某职业技术学院", majorName: "机电一体化" }
    ]
  });
  const merged = profileApi.mergeResumeFields(template, profile);
  const values = merged.map((field) => field.value);
  assert.equal(values.includes("清华大学"), false, "硕士段被模板覆盖");
  assert.ok(values.includes("某职业技术学院"), "简历里没有的专科段仍要保留");
});


test("entryProfile reads the active 我的信息's own base info, and falls back to the shared one", () => {
  const shared = { values: { name: "共用" }, education: [], family: [], custom: [] };
  const store = {
    templates: [
      { id: "a", name: "硬件方向", groups: [], profile: { values: { name: "硬件" } } },
      { id: "b", name: "软件方向", groups: [], profile: { values: { name: "软件" } } }
    ],
    activeTemplateId: "b",
    profile: shared
  };

  assert.equal(profileApi.entryProfile(store).values.name, "软件", "跟着当前那份走");
  assert.equal(profileApi.entryProfile({ ...store, activeTemplateId: "a" }).values.name, "硬件");
  assert.equal(profileApi.entryProfile({ ...store, activeTemplateId: "不存在" }).values.name, "硬件", "id 对不上时用第一份");
  assert.equal(
    profileApi.entryProfile({ templates: [], activeTemplateId: "", profile: shared }).values.name,
    "共用",
    "一份都没有时退回全局那份"
  );
});

test("an entry that deliberately cleared its base info stays empty instead of inheriting the shared one", () => {
  const store = {
    templates: [{ id: "a", name: "空方向", groups: [], profile: { values: {}, education: [], family: [], custom: [] } }],
    activeTemplateId: "a",
    profile: { values: { name: "别人的" } }
  };

  const profile = profileApi.entryProfile(store);
  assert.deepEqual(JSON.parse(JSON.stringify(profile.values)), {}, "自己那份是空的就保持空，不能拿全局的去填");
});

test("activeEntry returns the selected entry, or the first one when the id is stale", () => {
  const store = { templates: [{ id: "x", name: "X" }, { id: "y", name: "Y" }], activeTemplateId: "y" };
  assert.equal(profileApi.activeEntry(store).id, "y");
  assert.equal(profileApi.activeEntry({ ...store, activeTemplateId: "gone" }).id, "x");
  assert.equal(profileApi.activeEntry({ templates: [] }), null);
});
