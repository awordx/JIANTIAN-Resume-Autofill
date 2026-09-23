// 「我的信息」：网申表常问、简历里通常没有的字段。设置页、侧边栏和测试共用这一份定义。
(function attachResumeProProfile(globalScope) {
  const YES_NO = ["是", "否"];

  // id 是存储用的键，改了会丢用户数据；key 是交给匹配规则和 AI 的字段名，也是侧边栏芯片上的字。
  // 地区字段的 key 按「归属 + 层级」命名（籍贯省、户口所在地区县），ai-helpers 靠它分清省市县。
  // aliases 只用来判断「网页上这个字段我们已经有了」，不会作为字段名交出去。
  const PROFILE_SCHEMA = [
    { name: "基本信息", fields: [
      { id: "name", key: "姓名", aliases: ["真实姓名"] }, { id: "namePinyin", key: "姓名拼音", aliases: ["拼音"] }, { id: "usedName", key: "曾用名" },
      { id: "gender", key: "性别", type: "select", options: ["男", "女"] }, { id: "birth", key: "出生年月", label: "出生日期", type: "date", aliases: ["出生日期", "生日"] }, { id: "ethnicity", key: "民族" },
      { id: "political", key: "政治面貌", type: "select", options: ["中共党员", "中共预备党员", "共青团员", "民主党派", "群众"] }, { id: "marital", key: "婚姻状况", type: "select", options: ["未婚", "已婚", "离异", "丧偶"], aliases: ["婚否"] },
      { id: "idType", key: "证件类型", type: "select", options: ["居民身份证", "护照", "其他"] }, { id: "idNumber", key: "证件号码", aliases: ["证件号", "身份证号"] }, { id: "height", key: "身高", label: "身高（厘米）" }, { id: "weight", key: "体重", label: "体重（公斤）" },
      { id: "health", key: "健康状况", type: "select", options: ["健康", "良好", "一般"] }, { id: "seriousDisease", key: "有无重大疾病史", type: "select", options: ["无", "有"] }, { id: "nationality", key: "国籍" }, { id: "birthplace", key: "出生地" },
      { id: "bloodType", key: "血型", type: "select", options: ["A型", "B型", "AB型", "O型", "其他"] }, { id: "disability", key: "是否残疾", type: "select", options: YES_NO },
      { id: "nativeProvince", key: "籍贯省", label: "籍贯（省）" }, { id: "nativeCity", key: "籍贯市", label: "籍贯（市）" }, { id: "nativeCounty", key: "籍贯县", label: "籍贯（区县）" }, { id: "hukouProvince", key: "户口所在地省", label: "户口所在地（省）" }, { id: "hukouCity", key: "户口所在地市", label: "户口所在地（市）" }, { id: "hukouCounty", key: "户口所在地区县", label: "户口所在地（区县）" }, { id: "hukouType", key: "户口性质", type: "select", options: ["城镇", "农村"] }, { id: "examProvince", key: "高考生源地省" }, { id: "examCity", key: "高考生源地市" }, { id: "homeAddress", key: "家庭住址", type: "textarea" }, { id: "currentAddress", key: "现居住地", type: "textarea" },
      { id: "phone", key: "手机号码", aliases: ["手机", "手机号", "联系电话"] }, { id: "email", key: "常用邮箱", aliases: ["邮箱", "电子邮箱"] }, { id: "emergencyName", key: "紧急联系人姓名" }, { id: "emergencyRelation", key: "紧急联系人关系" }, { id: "emergencyPhone", key: "紧急联系人电话" },
      { id: "language", key: "外语语种" }, { id: "languageLevel", key: "外语等级", type: "select", options: ["未参加", "未通过", "四级", "六级", "专业四级", "专业八级", "雅思", "托福", "托业"] }, { id: "languageScore", key: "外语成绩" }, { id: "computerLevel", key: "计算机水平" }, { id: "drivingLicense", key: "驾驶证", type: "select", options: ["无", "C1", "C2", "B1", "B2", "A1", "A2", "A3"] }, { id: "professionalTitle", key: "专业技术职称" }, { id: "skills", key: "技能特长", type: "textarea" }
    ] },
    { name: "工作经历", fields: [
      { id: "workStart", key: "开始时间", type: "date" }, { id: "workEnd", key: "结束时间", type: "date" }, { id: "workType", key: "工作类型", type: "select", options: ["实习", "正式工作"] }, { id: "company", key: "公司" }, { id: "department", key: "部门" }, { id: "salary", key: "工资" }, { id: "position", key: "职位" }, { id: "content", key: "工作内容", type: "textarea" }, { id: "result", key: "工作成果", type: "textarea" }
    ] },
  ];

  const FAMILY_GROUP = "家庭主要成员";
  const FAMILY_RELATIONS = ["父亲", "母亲", "配偶", "兄弟姐妹", "子女", "其他亲属"];
  // 这几种关系只会有一个人，备份追加时按关系对上；其他关系按姓名对上。
  const SINGLE_RELATIONS = new Set(["父亲", "母亲", "配偶"]);
  const FAMILY_FIELDS = [
    { id: "name", key: "姓名" },
    { id: "birth", key: "出生年月", label: "出生日期", type: "date", placeholder: "YYYY-MM-DD" },
    { id: "political", key: "政治面貌" },
    { id: "company", key: "工作单位" },
    { id: "job", key: "职务" },
    { id: "phone", key: "联系电话" }
  ];

  const EDUCATION_GROUP = "教育经历";
  // 可重复的教育段，字段和用户提供的网申表保持一致。每段单独保存，避免本科、硕士
  // 等经历相互覆盖；日期保留到日，网页只有年月时由填写器按网页精度处理。
  const EDUCATION_FIELDS = [
    { id: "startTime", key: "开始时间", type: "date", placeholder: "YYYY-MM-DD", aliases: ["入学时间"] },
    { id: "endTime", key: "结束时间", type: "date", placeholder: "YYYY-MM-DD", aliases: ["毕业时间", "毕业日期"] },
    { id: "eduLevel", key: "学历", type: "select", options: ["博士研究生", "硕士研究生", "MBA", "本科", "专科", "中专", "高中", "初中", "小学", "其他"] },
    { id: "schoolName", key: "学校", aliases: ["学校名称", "毕业院校"] },
    { id: "collegeName", key: "学院（院系）", aliases: ["学院", "院系"] },
    { id: "majorName", key: "专业", aliases: ["专业名称", "所学专业"] },
    { id: "degree", key: "学位", type: "select", options: ["学士", "双学士", "硕士", "博士", "MBA", "高中", "其他"] },
    { id: "studyForm", key: "学习形式", type: "select", options: ["全日制", "成人高等教育", "统招专升本", "自学考试", "非统专升本", "海外留学生", "非全日制", "网络教育", "其他"], aliases: ["培养方式"] },
    { id: "majorCourses", key: "专业课程", aliases: ["主修课程", "课程"] },
    { id: "researchDirection", key: "研究方向" },
    { id: "graduationThesis", key: "毕业论文", aliases: ["论文情况", "论文"] },
    { id: "score", key: "成绩（GPA）", aliases: ["GPA", "绩点成绩"] },
    { id: "ranking", key: "专业排名", aliases: ["排名"], type: "select", options: ["前5%", "前10%", "前20%", "前30%", "前50%", "后50%", "后40%", "后30%", "后20%", "后10%"] },
    { id: "overseasEducation", key: "是否为海外教育经历", type: "select", options: YES_NO },
    { id: "minorOrDoubleMajor", key: "辅修/双学位专业" },
    { id: "mentorName", key: "导师姓名" }
  ];

  const LEGACY_EDUCATION_IDS = new Set(["highestEducation", "highestDegree", "studyMode", "schoolName", "discipline", "firstDiscipline", "majorName", "admission", "graduation", "gpa", "classRank", "studentCadre", "doubleDegree", "upgrade", "highSchool"]);

  function legacyEducationValue(values, id) {
    const raw = text(values[id]);
    if (id === "highestEducation") return ({ "大学本科": "本科", "大学专科": "专科", "高中及以下": "高中" })[raw] || raw;
    if (id === "studyMode") return ({ "全国普通高等院校全日制": "全日制", "全国普通高等院校非全日制": "非全日制", "非统招专升本": "非统专升本" })[raw] || raw;
    return raw;
  }

  const CUSTOM_GROUP = "补充字段";
  const EXTRA_GROUP_SCHEMAS = [
    { id: "campus", name: "在校经历", fields: [
      { id: "startTime", key: "开始时间", type: "date" }, { id: "endTime", key: "结束时间", type: "date" },
      { id: "experienceType", key: "经历类型", type: "select", options: ["社团组织", "社团实践"] }, { id: "position", key: "职位" }, { id: "content", key: "工作内容", type: "textarea" }
    ] },
    { id: "projects", name: "项目经历", fields: [
      { id: "startTime", key: "开始时间", type: "date" }, { id: "endTime", key: "结束时间", type: "date" }, { id: "position", key: "职位" }, { id: "name", key: "项目名称" }, { id: "content", key: "项目内容", type: "textarea" }, { id: "responsibility", key: "本人职责", type: "textarea" }
    ] },
    { id: "awards", name: "获奖情况", fields: [
      { id: "date", key: "获奖时间", type: "date" }, { id: "name", key: "奖励名称" }, { id: "organization", key: "颁奖机构" }, { id: "level", key: "奖励等级" }, { id: "description", key: "奖励描述", type: "textarea" }
    ] },
    { id: "certificates", name: "资格证书", fields: [
      { id: "date", key: "获得时间", type: "date" }, { id: "name", key: "证书名称" }, { id: "number", key: "证书编号" }, { id: "description", key: "证书说明", type: "textarea" }
    ] },
    { id: "papers", name: "论文期刊", fields: [
      { id: "date", key: "发表时间", type: "date" }, { id: "journal", key: "刊物名称" }, { id: "level", key: "刊物层级", type: "select", options: ["无发表论文", "SCI一区", "SCI二区", "SCI三区", "中文核心刊物", "其他刊物"] }, { id: "name", key: "论文名称" }, { id: "description", key: "论文描述", type: "textarea" }, { id: "author", key: "论文作者", type: "select", options: ["无发表论文", "共同第一作者", "第一作者", "第二作者", "第三作者", "其他作者"] }, { id: "impactFactor", key: "期刊影响因子" }, { id: "link", key: "论文链接" }
    ] },
    { id: "patents", name: "专利", fields: [
      { id: "date", key: "发表时间", type: "date" }, { id: "name", key: "专利名称" }, { id: "number", key: "专利编号" }, { id: "type", key: "专利类型" }, { id: "result", key: "专利成果", type: "textarea" }
    ] },
    { id: "competitions", name: "竞赛", fields: [
      { id: "name", key: "竞赛名称" }, { id: "date", key: "参与时间", type: "date" }, { id: "content", key: "详情内容", type: "textarea" }
    ] }
  ];


  const MAX_CUSTOM_FIELDS = 200;
  const MAX_OFFERED_LABELS = 20;

  const SKIPPED_INPUT_TYPES = new Set(["password", "file", "checkbox", "hidden", "submit", "button", "reset", "image"]);
  // 补充字段是用户自己起的名，拦不住一行叫「网银密码」：这种字段不推荐、不交给 AI。
  const SECRET_LABEL = /密码|口令|验证码|校验码|授权码|密钥|私钥|令牌|password|passwd|captcha|token|secret/i;
  // 名字普通、内容却是「密码：xxx」这种写法的，同样不交给 AI。
  const SECRET_VALUE = /(密码|口令|验证码|校验码|授权码|密钥|令牌|password|passwd|pwd|token|secret)\s*[:=：]\s*\S/i;

  function text(value) {
    return String(value ?? "").trim();
  }

  function normalizeKey(value) {
    return text(value).toLowerCase().replace(/[\s:：*（）()【】[\]\-_/.·]+/g, "");
  }

  function dateFieldKey(value) {
    const key = normalizeKey(value);
    if (/出生年月|出生日期|生日|birth/.test(key)) return "birth";
    if (/毕业时间|毕业日期|graduation/.test(key)) return "graduation";
    if (/可到岗时间|到岗日期|availabledate/.test(key)) return "availableDate";
    return "";
  }

  // 「此处姓名」这类是示例/占位文本，不是用户真实数据。它们一旦进入候选值，AI 和本地规则都会当真值
  // 填进网页（实测把家庭成员填成「此处姓名」、把期望工作地点填成「此处期望工作地点」）。这里统一在读取
  // 档案时把它们当作「未填」，让简历模板里的真实数据或用户后来补的内容来填。
  // 只用「明确不可能出现在真实资料里」的写法：像「李四」「王五」这类看着像示例、但确实是合法中文姓名
  // 的值不做自动丢弃——替用户判定真名太危险，宁可留给用户自己核对（项目自带测试也把它们当普通数据）。
  const PLACEHOLDER_TEXT = /此处|某某|示例|样例|例子|placeholder|lorem|待填|请填写|^x{2,}$/i;

  function isPlaceholderValue(value) {
    const clean = text(value);
    if (!clean) return true;
    return PLACEHOLDER_TEXT.test(clean);
  }

  function realValue(value) {
    const clean = text(value);
    return isPlaceholderValue(clean) ? "" : clean;
  }

  function emptyProfile() {
    return { values: {}, education: [], family: [], custom: [], extraGroups: {} };
  }

  function normalizeProfile(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const profile = emptyProfile();

    if (source.values && typeof source.values === "object") {
      for (const [id, value] of Object.entries(source.values)) {
        const clean = realValue(value);
        if (clean) profile.values[id] = clean;
      }
    }

    for (const member of Array.isArray(source.family) ? source.family : []) {
      if (!member || typeof member !== "object") continue;

      const relation = text(member.relation);
      const next = { relation: FAMILY_RELATIONS.includes(relation) ? relation : "其他亲属" };
      FAMILY_FIELDS.forEach((field) => {
        next[field.id] = realValue(member[field.id]);
      });

      if (FAMILY_FIELDS.some((field) => next[field.id])) {
        profile.family.push(next);
      }
    }

    for (const record of Array.isArray(source.education) ? source.education : []) {
      if (!record || typeof record !== "object") continue;
      const next = {};
      EDUCATION_FIELDS.forEach((field) => {
        next[field.id] = realValue(record[field.id]);
      });
      if (EDUCATION_FIELDS.some((field) => next[field.id])) profile.education.push(next);
    }

    // 0.4.7 及以前的教育概况在 values 里。第一次升级时把它变成一段教育经历，
    // 后续页面与填写器只读取 education，避免两套数据冲突。
    if (!profile.education.length) {
      const legacy = {
        startTime: legacyEducationValue(profile.values, "admission"),
        endTime: legacyEducationValue(profile.values, "graduation"),
        eduLevel: legacyEducationValue(profile.values, "highestEducation"),
        schoolName: legacyEducationValue(profile.values, "schoolName") || legacyEducationValue(profile.values, "highSchool"),
        majorName: legacyEducationValue(profile.values, "majorName"),
        degree: legacyEducationValue(profile.values, "highestDegree"),
        studyForm: legacyEducationValue(profile.values, "studyMode"),
        score: legacyEducationValue(profile.values, "gpa"),
        ranking: legacyEducationValue(profile.values, "classRank")
      };
      if (Object.values(legacy).some(Boolean)) profile.education.push(legacy);
    }
    LEGACY_EDUCATION_IDS.forEach((id) => { delete profile.values[id]; });

    for (const schema of EXTRA_GROUP_SCHEMAS) {
      const rows = Array.isArray(source.extraGroups?.[schema.id]) ? source.extraGroups[schema.id] : [];
      if (!source.extraGroups || !Object.prototype.hasOwnProperty.call(source.extraGroups, schema.id)) continue;
      profile.extraGroups[schema.id] = rows.map((row) => {
        const next = {};
        schema.fields.forEach((field) => { next[field.id] = realValue(row?.[field.id]); });
        return next;
      }).filter((row) => schema.fields.some((field) => row[field.id]));
    }


    // 同名的只留一条，优先留有内容的，免得先加的空行把后填的内容挤掉。
    const byKey = new Map();
    for (const item of Array.isArray(source.custom) ? source.custom : []) {
      const key = text(item?.key);
      const normalized = normalizeKey(key);
      if (!normalized) continue;

      const value = realValue(item?.value);
      const existing = byKey.get(normalized);
      if (existing) {
        if (!existing.value && value) existing.value = value;
        continue;
      }
      if (byKey.size >= MAX_CUSTOM_FIELDS) continue;
      byKey.set(normalized, { key, value });
    }
    profile.custom = [...byKey.values()];

    return profile;
  }

  // 同一关系有多人时加序号（兄弟姐妹1、兄弟姐妹2），只有一人时不加。
  function familyPrefixes(family) {
    const totals = {};
    family.forEach((member) => {
      totals[member.relation] = (totals[member.relation] || 0) + 1;
    });
    const seen = {};
    return family.map((member) => {
      seen[member.relation] = (seen[member.relation] || 0) + 1;
      return totals[member.relation] > 1 ? `${member.relation}${seen[member.relation]}` : member.relation;
    });
  }

  function profileToResumeFields(rawProfile) {
    const profile = normalizeProfile(rawProfile);
    const fields = [];

    PROFILE_SCHEMA.forEach((group) => {
      group.fields.forEach((field) => {
        const value = profile.values[field.id];
        if (value) fields.push({ group: group.name, key: field.key, value });
      });
    });

    const prefixes = familyPrefixes(profile.family);
    profile.family.forEach((member, index) => {
      // 家庭成员表格里常有一列「关系 / 称谓」下拉框。
      fields.push({ group: FAMILY_GROUP, key: `${prefixes[index]}关系`, value: member.relation });
      FAMILY_FIELDS.forEach((field) => {
        if (member[field.id]) fields.push({ group: FAMILY_GROUP, key: `${prefixes[index]}${field.key}`, value: member[field.id] });
      });
    });

    profile.education.forEach((record, index) => {
      EDUCATION_FIELDS.forEach((field) => {
        if (record[field.id]) fields.push({ group: `${EDUCATION_GROUP}${index + 1}`, key: field.key, value: record[field.id] });
      });
    });

    EXTRA_GROUP_SCHEMAS.forEach((schema) => {
      (profile.extraGroups?.[schema.id] || []).forEach((record, index) => {
        schema.fields.forEach((field) => {
          if (record[field.id]) fields.push({ group: schema.name, key: field.key, value: record[field.id] });
        });
      });
    });
    const emitted = new Set(fields.map((field) => normalizeKey(field.key)));
    profile.custom.forEach((item) => {
      const normalized = normalizeKey(item.key);
      if (!item.value || SECRET_LABEL.test(item.key) || SECRET_VALUE.test(item.value) || emitted.has(normalized)) return;
      emitted.add(normalized);
      fields.push({ group: CUSTOM_GROUP, key: item.key, value: item.value });
    });

    return fields;
  }

  function countProfileValues(profile) {
    return profileToResumeFields(profile).length;
  }

  function countPendingFields(profile) {
    return normalizeProfile(profile).custom.filter((item) => !item.value).length;
  }

  function hasProfileContent(profile) {
    const normalized = normalizeProfile(profile);
    return Boolean(Object.keys(normalized.values).length || normalized.education.length || normalized.family.length || normalized.custom.length);
  }

  // 模板教育字段的字段名形如「华北理工大学教育经历-学校」，学历层次写在值里
  // （专业常写成「控制科学与工程/硕士」，也可能单列在 学历/学位 里）。
  const EDUCATION_LEVELS = [/博士/, /硕士|研究生|mba/i, /本科|学士/i, /专科|大专|高职/];

  function educationLevel(value) {
    return EDUCATION_LEVELS.find((pattern) => pattern.test(text(value)))?.source || "";
  }

  function educationFieldId(key) {
    const normalized = normalizeKey(key);
    return EDUCATION_FIELDS.find((field) => [field.key, ...(field.aliases || [])]
      .some((name) => normalizeKey(name) === normalized))?.id || "";
  }

  // 模板里的教育时间是一个区间字段（「2023.09—2026.06」），一个字段同时代表开始与结束时间。
  const EDUCATION_TIME_KEYS = new Set(["时间", "起止时间", "就读时间", "在校时间"]);

  // 模板优先：模板里已有的字段名，档案里的同名字段不再加入。
  function mergeResumeFields(templateFields, profileFields) {
    const template = Array.isArray(templateFields) ? templateFields : [];
    const profile = Array.isArray(profileFields) ? profileFields : [];
    const completeDates = new Set(profile
      .map((field) => [dateFieldKey(field?.key), text(field?.value)])
      .filter(([key, value]) => key && /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(value))
      .map(([key]) => key));
    const filteredTemplate = template.filter((field) => {
      const key = dateFieldKey(field?.key);
      return !key || !completeDates.has(key);
    });
    const taken = new Set(filteredTemplate.map((field) => normalizeKey(field?.key)));

    // 模板里已经写过的教育段，按「学历层次」认同一段经历：同一层次里模板给了的语义字段
    // （学校/专业/GPA/排名/时间…）不再从档案带进来覆盖。实测档案里那一版教育段是半填充的示例
    // 数据（学校=清华大学、GPA=3.9），一旦让它参与匹配，AI 会把简历里的真实学校覆盖掉。
    const coveredByLevel = new Map();
    const entities = new Map();
    filteredTemplate.forEach((field) => {
      const key = text(field?.key);
      const match = key.match(/^(.+?)教育经历[-－]/);
      if (!match) return;
      const entity = entities.get(match[1]) || { level: "", names: new Set() };
      entities.set(match[1], entity);
      entity.names.add(key.slice(match[0].length));
      if (!entity.level) entity.level = educationLevel(field.value);
    });
    entities.forEach((entity) => {
      if (!entity.level) return;
      const ids = coveredByLevel.get(entity.level) || new Set();
      entity.names.forEach((name) => {
        if (EDUCATION_TIME_KEYS.has(normalizeKey(name))) {
          ids.add("startTime");
          ids.add("endTime");
          return;
        }
        const id = educationFieldId(name);
        if (id) ids.add(id);
      });
      coveredByLevel.set(entity.level, ids);
    });

    const profileEducationLevels = new Map();
    profile.forEach((field) => {
      const group = text(field?.group);
      if (!group.startsWith(EDUCATION_GROUP) || profileEducationLevels.has(group)) return;
      const level = educationLevel(field.value);
      if (level) profileEducationLevels.set(group, level);
    });

    const keepProfileField = (field) => {
      const group = text(field?.group);
      if (!group.startsWith(EDUCATION_GROUP)) return !taken.has(normalizeKey(field.key));
      const covered = coveredByLevel.get(profileEducationLevels.get(group) || "");
      if (!covered?.size) return true;
      const id = educationFieldId(field.key);
      return !(id && covered.has(id));
    };

    return [
      // source 交给 AI 判断优先级：模板是本次投递用的简历，档案只补模板没有的字段。
      ...filteredTemplate.map((field) => (field && typeof field === "object" ? { ...field, source: "template" } : field)),
      // 教育经历是可重复分组。即使模板中有同名“学校/专业”，用户新增的每一段
      // 也必须交给 AI 按分组语义匹配，不能被单个同名字段整体挡掉。
      ...profile.filter(keepProfileField).map((field) => (field && typeof field === "object" ? { ...field, source: "profile" } : field))
    ];
  }

  // 已经有着落的字段名：预置字段（字段名、界面标签、别名）、已有家庭成员的全部字段、补充字段、模板字段。
  function knownFieldKeys(rawProfile, resumeFields) {
    const profile = normalizeProfile(rawProfile);
    const keys = new Set();
    const add = (value) => {
      const normalized = normalizeKey(value);
      if (normalized) keys.add(normalized);
    };

    PROFILE_SCHEMA.forEach((group) => group.fields.forEach((field) => {
      add(field.key);
      add(field.label);
      (field.aliases || []).forEach(add);
    }));
    // 成员已经在档案里、只是某一项没填：这一项该去成员那里补，不该另起一个补充字段。
    familyPrefixes(profile.family).forEach((prefix) => {
      add(`${prefix}关系`);
      FAMILY_FIELDS.forEach((field) => add(`${prefix}${field.key}`));
    });
    EDUCATION_FIELDS.forEach((field) => {
      add(field.key);
      add(field.label);
      (field.aliases || []).forEach(add);
    });
    profile.custom.forEach((item) => add(item.key));
    (Array.isArray(resumeFields) ? resumeFields : []).forEach((field) => add(field?.key));

    return keys;
  }

  // 一次填写之后，网页上既没匹配上、也还空着的字段。密码验证码、文件、勾选框不算。
  function pickUnansweredLabels(candidates, knownKeys, limit = MAX_OFFERED_LABELS) {
    const picked = [];
    const seen = new Set();

    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const label = text(candidate?.label);
      const normalized = normalizeKey(label);

      if (candidate?.matched || candidate?.hasValue) continue;
      if (normalized.length < 2 || label.length > 30) continue;
      if (SKIPPED_INPUT_TYPES.has(candidate?.inputType) || SECRET_LABEL.test(label)) continue;
      if (knownKeys?.has(normalized) || seen.has(normalized)) continue;

      seen.add(normalized);
      picked.push(label);
      if (picked.length >= limit) break;
    }

    return picked;
  }

  function addPendingFields(rawProfile, labels, resumeFields = []) {
    const profile = normalizeProfile(rawProfile);
    const known = knownFieldKeys(profile, resumeFields);
    let added = 0;
    let full = false;

    for (const label of Array.isArray(labels) ? labels : []) {
      const key = text(label);
      const normalized = normalizeKey(key);
      if (!normalized || known.has(normalized) || SECRET_LABEL.test(key)) continue;
      if (profile.custom.length >= MAX_CUSTOM_FIELDS) {
        full = true;
        break;
      }
      known.add(normalized);
      profile.custom.push({ key, value: "" });
      added += 1;
    }

    return { profile, added, full };
  }

  // 设置页表单读出来的一组 { kind, row, field, value }，还原成档案。
  function profileFromResumeFields(rawProfile, groups) {
    const profile = emptyProfile();
    const rawGroups = Array.isArray(groups) ? groups : [];
    const fields = rawGroups.flatMap((group) =>
      (Array.isArray(group?.fields) ? group.fields : []).map((field) => ({
        group: text(group?.name),
        key: text(field?.key),
        value: text(field?.value)
      }))
    );

    const matchSchemaField = (field, schemaFields) => {
      const key = normalizeKey(field.key);
      return schemaFields.find((schemaField) => [schemaField.key, schemaField.label, ...(schemaField.aliases || [])]
        .filter(Boolean).map(normalizeKey).includes(key));
    };

    PROFILE_SCHEMA.forEach((group) => {
      group.fields.forEach((schemaField) => {
        const match = fields.find((field) => {
          if (!field.value || /教育|学历|学位|学校|院系|专业课程/.test(field.group)) return false;
          return matchSchemaField(field, [schemaField]);
        });
        if (match) profile.values[schemaField.id] = match.value;
      });
    });

    rawGroups.filter((group) => /教育|教育背景|学历|学习经历/.test(text(group?.name))).forEach((group) => {
      const record = {};
      (Array.isArray(group.fields) ? group.fields : []).forEach((rawField) => {
        const field = { key: text(rawField?.key), value: text(rawField?.value) };
        if (!field.value) return;
        const schemaField = matchSchemaField(field, EDUCATION_FIELDS);
        if (schemaField) record[schemaField.id] = field.value;
      });
      if (Object.keys(record).length) profile.education.push(record);
    });

  const sectionMap = new Map([
    ["在校经历", "campus"], ["项目经历", "projects"], ["获奖情况", "awards"], ["资格证书", "certificates"], ["论文期刊", "papers"], ["专利", "patents"], ["竞赛", "competitions"]
  ]);
  rawGroups.forEach((group) => {
    const id = sectionMap.get(text(group?.name));
    const schema = EXTRA_GROUP_SCHEMAS.find((item) => item.id === id);
    if (!schema) return;
    const row = {};
    (Array.isArray(group.fields) ? group.fields : []).forEach((field) => {
      const match = matchSchemaField({ key: text(field?.key) }, schema.fields);
      if (match && text(field?.value)) row[match.id] = text(field.value);
    });
    if (Object.keys(row).length) profile.extraGroups[id] = [row];
  });

  return normalizeProfile(profile);
  }

  // 设置页表单读出来的一组 { kind, row, field, value }，还原成档案。
  function profileFromEntries(entries) {
    const values = {};
    const education = new Map();
    const family = new Map();
    const custom = new Map();
    const extra = {};

    for (const entry of Array.isArray(entries) ? entries : []) {
      const value = String(entry?.value ?? "");

      if (entry?.kind === "value") {
        values[entry.field] = value;
      } else if (entry?.kind === "education") {
        if (!education.has(entry.row)) education.set(entry.row, {});
        education.get(entry.row)[entry.field] = value;
      } else if (entry?.kind === "family") {
        if (!family.has(entry.row)) family.set(entry.row, {});
        family.get(entry.row)[entry.field] = value;
      } else if (entry?.kind === "extra") {
        if (!extra[entry.group]) extra[entry.group] = new Map();
        if (!extra[entry.group].has(entry.row)) extra[entry.group].set(entry.row, {});
        extra[entry.group].get(entry.row)[entry.field] = value;
      } else if (entry?.kind === "custom") {
        if (!custom.has(entry.row)) custom.set(entry.row, {});
        custom.get(entry.row)[entry.field] = value;
      }
    }

    return normalizeProfile({ values, education: [...education.values()], family: [...family.values()], custom: [...custom.values()], extraGroups: Object.fromEntries(Object.entries(extra).map(([id, rows]) => [id, [...rows.values()]])) });
  }

  function isSameMember(left, right) {
    if (left.relation !== right.relation) return false;
    if (SINGLE_RELATIONS.has(left.relation)) return true;
    return Boolean(left.name) && normalizeKey(left.name) === normalizeKey(right.name);
  }

  function educationIdentity(record) {
    return [record.schoolName, record.majorName, record.startTime, record.endTime].map(normalizeKey).join("|");
  }

  // 备份追加时用：本机已经填了的不动，只补本机空着的。
  function mergeProfiles(localProfile, incomingProfile) {
    const local = normalizeProfile(localProfile);
    const incoming = normalizeProfile(incomingProfile);

    const values = { ...incoming.values, ...local.values };

    const family = local.family.map((member) => ({ ...member }));
    incoming.family.forEach((member) => {
      const match = family.find((existing) => isSameMember(existing, member));
      if (!match) {
        family.push({ ...member });
        return;
      }
      FAMILY_FIELDS.forEach((field) => {
        if (!match[field.id] && member[field.id]) match[field.id] = member[field.id];
      });
    });

    const education = local.education.map((record) => ({ ...record }));
    incoming.education.forEach((record) => {
      const identity = educationIdentity(record);
      const match = identity && education.find((existing) => educationIdentity(existing) === identity);
      if (!match) {
        education.push({ ...record });
        return;
      }
      EDUCATION_FIELDS.forEach((field) => {
        if (!match[field.id] && record[field.id]) match[field.id] = record[field.id];
      });
    });

    const custom = local.custom.map((item) => {
      if (item.value) return item;
      const match = incoming.custom.find((other) => normalizeKey(other.key) === normalizeKey(item.key));
      return match?.value ? { key: item.key, value: match.value } : item;
    });
    const localKeys = new Set(local.custom.map((item) => normalizeKey(item.key)));
    incoming.custom.forEach((item) => {
      if (!localKeys.has(normalizeKey(item.key))) custom.push(item);
    });

    return normalizeProfile({ values, education, family, custom });
  }

  // 每份「我的信息」自带一份基础信息（姓名/教育/家庭/补充字段），各投递方向互不干扰。
  // 老数据、或刚建好还没写过基础信息的条目没有自己那份时，退回全局那份 —— normalizeStore 在读取时
  // 会把全局那份拷进缺少的条目里，等于一次性迁移，用户不用做任何事。
  function activeEntry(store) {
    const entries = Array.isArray(store?.templates) ? store.templates : [];
    return entries.find((entry) => entry && entry.id === store?.activeTemplateId) || entries[0] || null;
  }

  function entryProfile(store) {
    const entry = activeEntry(store);
    const own = entry && entry.profile && typeof entry.profile === "object" ? entry.profile : null;
    return normalizeProfile(own || store?.profile);
  }

  const api = {
    CUSTOM_GROUP,
    EDUCATION_FIELDS,
    EDUCATION_GROUP,
    EXTRA_GROUP_SCHEMAS,
    FAMILY_FIELDS,
    FAMILY_GROUP,
    FAMILY_RELATIONS,
    PROFILE_SCHEMA,
    activeEntry,
    addPendingFields,
    countPendingFields,
    countProfileValues,
    emptyProfile,
    entryProfile,
    hasProfileContent,
    isPlaceholderValue,
    knownFieldKeys,
    mergeProfiles,
    mergeResumeFields,
    normalizeProfile,
    pickUnansweredLabels,
    profileFromEntries,
    profileFromResumeFields,
    profileToResumeFields
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalScope.ResumeProProfile = api;
})(typeof self !== "undefined" ? self : globalThis);
