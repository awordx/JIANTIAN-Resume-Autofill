const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const projectDir = fs.existsSync(path.join(__dirname, 'content.js')) ? __dirname : path.join(__dirname, '..');
const source = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');

function fixture({ delay = 90, commit = true } = {}) {
  class Element {
    constructor(text = '') { this.textContent = text; this.isConnected = true; }
    dispatchEvent() {}
    blur() {}
    contains() { return false; }
    click() { this.onClick?.(); }
    getAttribute() { return null; }
  }
  class Input extends Element { constructor() { super(); this.value = '2004-01-15'; } }
  const input = new Input();
  const shown = new Element('2004-01-15');
  const entry = { input, element: new Element() };
  entry.element.querySelector = () => new Element();
  entry.element.querySelectorAll = () => [shown];
  let year = 2004, month = 1, dayClicks = 0;
  let panel;
  const render = () => {
    if (panel) panel.isConnected = false;
    panel = new Element();
    panel.querySelector = selector => {
      if (selector === '.phoenix-calendar-year-select') return new Element(`${year}年`);
      if (selector === '.phoenix-calendar-month-select') return new Element(`${month}月`);
      const button = new Element();
      button.onClick = () => setTimeout(() => {
        const delta = selector.includes('prev') ? -1 : 1;
        if (selector.includes('year')) year += delta; else month += delta;
        render();
      }, delay);
      return button;
    };
    panel.querySelectorAll = () => Array.from({ length: 31 }, (_, i) => {
      const cell = new Element(String(i + 1));
      cell.onClick = () => {
        dayClicks++;
        if (commit) shown.textContent = `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
      };
      return cell;
    });
  };
  render();
  const context = {
    HTMLElement: Element, HTMLInputElement: Input,
    MouseEvent: class {}, Event: class {}, KeyboardEvent: class {},
    document: { querySelectorAll: () => [panel], body: new Element() },
    window: { setTimeout }, isVisible: () => true, getPhoenixFieldLabel: () => '出生日期',
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function inferPickerInputType('), source.indexOf('  function isVisible(')), context);
  vm.runInContext(source.slice(source.indexOf('  async function fillPhoenixSelect('), source.indexOf('  function findExactPhoenixSelectOption(')), context);
  return { context, entry, shown, dayClicks: () => dayClicks };
}

test('complete dates normalize and impossible or incomplete dates are rejected', () => {
  const { context: c } = fixture();
  assert.equal(c.parsePhoenixDate('2005-01'), null);
  assert.equal(c.parsePhoenixDate('2005-02-29'), null);
  assert.equal(c.parsePhoenixDate('2005年1月15日').year, 2005);
  assert.equal(c.parsePhoenixDate('2005.01.15').day, 15);
});

test('waits for delayed replacement calendar, selects 2005 instead of default 2004', async () => {
  const f = fixture();
  assert.equal(await f.context.fillPhoenixSelect(f.entry, '2005-02-15'), true);
  assert.equal(f.shown.textContent, '2005-02-15');
  assert.equal(f.dayClicks(), 1);
});

test('uncommitted date is failure even if clicked; no text-input success fallback', async () => {
  const f = fixture({ commit: false });
  assert.equal(await f.context.fillPhoenixSelect(f.entry, '2005-01-15'), false);
  assert.equal(f.entry.fillError, '网页未确认目标日期');
});

test('month-only birth value remains unfilled with actionable error', async () => {
  const f = fixture();
  assert.equal(await f.context.fillPhoenixSelect(f.entry, '2005-01'), false);
  assert.match(f.entry.fillError, /完整到日/);
  assert.equal(f.dayClicks(), 0);
});

test('profile displays full date picker and preserves legacy month text', () => {
  const popup = fs.readFileSync(path.join(projectDir, 'popup.js'), 'utf8');
  const c = { popupState: { profileRowSeq: 0 }, escapeHtml: s => String(s) };
  vm.createContext(c);
  vm.runInContext(popup.slice(popup.indexOf('function profileInputHtml('), popup.indexOf('function familyRowHtml(')), c);
  const schema = require(path.join(projectDir, 'profile-fields.js')).PROFILE_SCHEMA;
  const birth = schema.flatMap(group => group.fields).find(field => field.id === 'birth');
  assert.match(c.profileInputHtml(birth, '2005-01-15', ''), /type="date"/);
  const legacy = c.profileInputHtml(birth, '2005-01', '');
  assert.match(legacy, /value="2005-01"/);
  assert.match(legacy, /请补全/);
});

test('all preset dates including graduation, availability and family birth use day precision', () => {
  const { PROFILE_SCHEMA, EDUCATION_FIELDS, FAMILY_FIELDS } = require(path.join(projectDir, 'profile-fields.js'));
  const fields = PROFILE_SCHEMA.flatMap(group => group.fields);
  for (const id of ['birth', 'availableDate']) {
    assert.equal(fields.find(field => field.id === id).type, 'date');
  }
  for (const id of ['startTime', 'endTime']) assert.equal(EDUCATION_FIELDS.find(field => field.id === id).type, 'date');
  assert.equal(FAMILY_FIELDS.find(field => field.id === 'birth').type, 'date');
  assert.equal([...fields, ...FAMILY_FIELDS].some(field => field.type === 'month'), false);
});

test('webpage precision respects YYYY-MM and does not misread 年月日 or 毕业时间', () => {
  const { context: c } = fixture();
  const control = (placeholder, type = 'text', className = '') => ({ type, className, getAttribute: name => name === 'placeholder' ? placeholder : null });
  for (const [placeholder, expected] of [
    ['YYYY-MM', 'month'], ['请选择年月', 'month'], ['YYYY-MM-DD', 'date'],
    ['请选择年月日', 'date'], ['毕业时间', 'date'], ['HH:mm', 'time'],
    ['YYYY-MM-DD HH:mm', 'datetime-local'],
  ]) {
    const input = control(placeholder);
    assert.equal(c.inferPickerInputType(input, input), expected, placeholder);
  }
  const nativeMonth = control('', 'month');
  assert.equal(c.inferPickerInputType(nativeMonth, nativeMonth), 'month');
});

test('complete profile dates override stale template dates with alias labels', () => {
  const profile = require(path.join(projectDir, 'profile-fields.js'));
  const merged = profile.mergeResumeFields(
    [{ key: '出生日期', value: '2004-01-15' }, { key: '姓名', value: '模板姓名' }],
    [{ key: '出生年月', value: '2005-02-15' }, { key: '邮箱', value: 'a@example.com' }]
  );
  assert.deepEqual(merged, [
    { key: '姓名', value: '模板姓名', source: 'template' },
    { key: '出生年月', value: '2005-02-15', source: 'profile' },
    { key: '邮箱', value: 'a@example.com', source: 'profile' },
  ]);
});

test('fill loop resolves AI date plans through resolveDateValue before writing', () => {
  const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
  assert.match(content, /const plannedValue = resolveDateValue\(fieldMeta, match\.value, activeProfile\(\), profileFields\)/);
  assert.match(content, /const fillValue = adaptWebsiteValue\(fieldMeta, derivedValue \?\? plannedValue\)/);
  assert.match(content, /filled = setElementValue\(element, fillValue\)/);
  assert.match(content, /function resolveDateValue\(/);
  assert.match(content, /if \(isPlaceholderFillValue\(fillValue\)\)/);
});

function dateResolver() {
  const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
  const start = content.indexOf('  function parsePhoenixDate(');
  const end = content.indexOf('  async function confirmPhoenixCalendarDate(');
  const profile = require(path.join(projectDir, 'profile-fields.js'));
  const c = { self: { ResumeProProfile: profile } };
  vm.createContext(c);
  vm.runInContext(content.slice(start, end), c);
  return c;
}

// 2026-09-19 在 bocd.zhiye.com 实测用的真实档案（教育两段 + 毕业/参加工作时间 + 出生日期）。
const REAL_PROFILE = {
  education: [
    { startTime: '2023-09-19', endTime: '2026-06-19' },
    { startTime: '2019-09-19', endTime: '2023-06-19' },
  ],
  values: { birth: '2003-01-16', graduation: '2027-06-01', availableDate: '2027-06-01' },
  custom: [{ key: '工作年限', value: '0' }, { key: '参加工作时间', value: '2027/06/01' }],
  family: [{ birth: '2025-12-29' }],
};

test('AI month-only date plans are completed from the configured record', () => {
  const c = dateResolver();
  const cases = [
    ['毕业时间', '2026-06', '2026-06-19'],
    ['参加工作时间', '2027-06', '2027-06-01'],
    ['开始时间', '2023-09', '2023-09-19'],
    ['结束时间', '2026-06', '2026-06-19'],
    ['开始时间', '2019-09', '2019-09-19'],
    ['结束时间', '2023-06', '2023-06-19'],
    ['毕业时间', '2026年6月', '2026-06-19'],
  ];
  for (const [label, value, expected] of cases) {
    assert.equal(c.resolveDateValue({ label }, value, REAL_PROFILE, []), expected, `${label} ← ${value}`);
  }
});

test('template date ranges pick the side the field means, then complete from the record', () => {
  const c = dateResolver();
  assert.equal(c.resolveDateValue({ label: '开始时间' }, '2023.09—2026.06', REAL_PROFILE, []), '2023-09-19');
  assert.equal(c.resolveDateValue({ label: '结束时间' }, '2023.09—2026.06', REAL_PROFILE, []), '2026-06-19');
  assert.equal(c.resolveDateValue({ label: '结束时间' }, '2019.09—2023.06', REAL_PROFILE, []), '2023-06-19');
  // 「结束时间请选择」这类标签也算结束端
  assert.equal(c.resolveDateValue({ label: '结束时间请选择' }, '2025.06—2025.09', REAL_PROFILE, []), '2025-09-30');
});

test('months the record does not cover get a semantic day instead of being rejected', () => {
  const c = dateResolver();
  // 实习/工作段档案里没有完整日期：开始类补当月 1 日，结束类补当月最后一天
  assert.equal(c.resolveDateValue({ label: '开始时间' }, '2025-06', REAL_PROFILE, []), '2025-06-01');
  assert.equal(c.resolveDateValue({ label: '结束时间' }, '2025-09', REAL_PROFILE, []), '2025-09-30');
  assert.equal(c.resolveDateValue({ label: '开始时间' }, '2024-02', REAL_PROFILE, []), '2024-02-01');
  assert.equal(c.resolveDateValue({ label: '结束时间' }, '2024-02', REAL_PROFILE, []), '2024-02-29');
});

test('complete dates pass through untouched and non-date fields are never rewritten', () => {
  const c = dateResolver();
  assert.equal(c.resolveDateValue({ label: '出生日期' }, '2003-01-16', REAL_PROFILE, []), '2003-01-16');
  assert.equal(c.resolveDateValue({ label: '姓名' }, '王小明', REAL_PROFILE, []), '王小明');
  assert.equal(c.resolveDateValue({ label: '自我评价' }, '2026-06', REAL_PROFILE, []), '2026-06');
  assert.equal(c.resolveDateValue({ label: '身高(厘米)' }, '175', REAL_PROFILE, []), '175');
});

test('birth keeps the record value even when the AI plans a range or a bare month', () => {
  const c = dateResolver();
  // 实测里 AI 把出生日期计划成了教育区间：不能取区间某一端，必须回到档案里的出生日期
  assert.equal(c.resolveDateValue({ label: '出生日期' }, '2023.09—2026.06', REAL_PROFILE, []), '2003-01-16');
  assert.equal(c.resolveDateValue({ label: '出生日期' }, '2003-01', REAL_PROFILE, []), '2003-01-16');
  // 档案字段（profileFields）里的完整日期仍然兜底
  assert.equal(c.resolveDateValue({ label: '出生日期' }, '', REAL_PROFILE, [{ key: '出生年月', value: '2003-01-16' }]), '2003-01-16');
});

test('configured core fields supplement AI omissions with website aliases', () => {
  const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
  const start = content.indexOf('  function parsePhoenixDate(');
  const end = content.indexOf('  async function confirmPhoenixCalendarDate(');
  const profile = require(path.join(projectDir, 'profile-fields.js'));
  const c = { self: { ResumeProProfile: profile } };
  vm.createContext(c);
  vm.runInContext(content.slice(start, end), c);
  const fields = [
    { fieldId: 'ethnicity', label: '民族', options: [] },
    { fieldId: 'marital', label: '婚否', options: ['是', '否'] },
    { fieldId: 'english', label: '英语等级', options: [] },
  ];
  const values = [
    { key: '民族', value: '汉族' }, { key: '婚姻状况', value: '未婚' },
    { key: '外语等级', value: 'CET-6' },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(c.configuredFallbackMatches(fields, values, []))), [
    { fieldId: 'ethnicity', value: '汉族' }, { fieldId: 'marital', value: '否' },
    { fieldId: 'english', value: 'CET-6' },
  ]);
  assert.equal(c.adaptWebsiteValue({ label: '英语等级' }, 'CET-6'), '六级');
  assert.equal(c.adaptWebsiteValue({ label: '外语等级' }, 'CET-4'), '四级');
  assert.equal(c.adaptWebsiteValue({ label: '英语水平' }, 'TEM-4'), '专业四级');
  assert.equal(c.adaptWebsiteValue({ label: '英语等级' }, 'TEM-8'), '专业八级');
  assert.equal(c.adaptWebsiteValue({ label: '英语等级' }, 'IELTS 7.0'), '雅思');
  assert.equal(c.adaptWebsiteValue({ label: '专业技术职称' }, 'CET-6'), 'CET-6');
});

test('profile offers page-style date and select controls for expanded field types', () => {
  const { PROFILE_SCHEMA, EDUCATION_FIELDS } = require(path.join(projectDir, 'profile-fields.js'));
  const fields = PROFILE_SCHEMA.flatMap(group => group.fields);
  assert.equal(fields.find(field => field.id === 'workStart').type, 'date');
  assert.equal(EDUCATION_FIELDS.find(field => field.id === 'startTime').type, 'date');
  assert.equal(fields.find(field => field.id === 'bloodType').type, 'select');
  assert.equal(fields.find(field => field.id === 'drivingLicense').type, 'select');
  assert.ok(EDUCATION_FIELDS.find(field => field.id === 'studyForm').options.includes('全日制'));
  assert.ok(EDUCATION_FIELDS.find(field => field.id === 'studyForm').options.includes('网络教育'));
  assert.equal(fields.find(field => field.id === 'languageLevel').type, 'select');
  assert.ok(fields.find(field => field.id === 'languageLevel').options.includes('六级'));
  assert.ok(fields.find(field => field.id === 'selfEvaluation'));
  assert.ok(fields.find(field => field.id === 'professionalTitle'));
});

test('Phoenix labels and select confirmation are handled as components, not placeholder text', () => {
  const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
  assert.match(content, /getPhoenixFieldLabel\(element\)/);
  assert.match(content, /phoenixSelectHasValue\(select, value\)/);
  assert.match(content, /未找到网页中的对应选项/);
  assert.match(content, /confirmPhoenixSelectionIfNeeded\(select, value\)/);
  assert.match(content, /findSelectionConfirmationButton\(value\)/);
  assert.match(content, /已选\|已选择\|已勾选/);
});

test('Phoenix list items support the website full-time study-mode label', () => {
  const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
  assert.match(content, /phoenix-selectList__listItem/);
  assert.match(content, /constant-main-selector-container \.list-item-container/);
  assert.match(content, /document\.querySelectorAll\("\.list-item-container"\)/);
  assert.match(content, /document\.querySelectorAll\("\.item-text-label"\)/);
  assert.match(content, /item\.querySelector\("\.item-text-label"\)/);
  assert.match(content, /isPhoenixSelectorItemSelected/);
  assert.match(content, /phoenixSelectorHasSelectedValue/);
  assert.match(content, /attempt < 30/);
  assert.match(content, /resume-pro__field-waiting/);
  assert.match(content, /markPhoenixSelectWaiting/);
  assert.match(content, /clearPhoenixSelectWaiting/);
  assert.match(content, /setPhoenixPopupSearchValue/);
  assert.match(content, /selector-footer-button \.phoenix-button__wraper--primary/);
  assert.match(content, /select-data-container/);
  assert.match(content, /findSelectOptionIndex\?\.\(/);
  assert.match(content, /uniqueCandidates/);
  assert.match(content, /selectedTexts/);
  assert.match(content, /getPhoenixFieldLabel\(element\)/);
});

test('configured education records add only required webpage sections and isolated fill errors do not stop later fields', () => {
  const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
  assert.match(content, /ensureConfiguredEducationRows\(activeProfile\(\)/);
  assert.match(content, /label\[for\^='educationList\.'\]/);
  assert.match(content, /return `教育经历\$\{Number\(educationIndex\) \+ 1\}`/);
  assert.match(content, /normalizeAutocompleteText\(node\.textContent\) === "添加教育经历"/);
  assert.match(content, /单个控件的脚本或网页组件异常不能中断后续字段填写/);
});

function monthFixture({ commit = true } = {}) {
  class Element {
    constructor(text = '') { this.textContent = text; this.isConnected = true; this.className = ''; }
    dispatchEvent() {}
    blur() {}
    contains() { return false; }
    click() { this.onClick?.(); }
    getAttribute() { return null; }
  }
  class Input extends Element { constructor() { super(); this.value = ''; } }
  const input = new Input();
  const shown = new Element('');
  const entry = { input, element: new Element() };
  let year = 2026;
  const clicks = [];
  let panel;
  const render = () => {
    panel = new Element('');
    panel.className = 'phoenix-calendar phoenix-calendar-month-calendar';
    panel.querySelector = selector => {
      if (selector === '.phoenix-calendar-month-panel-year-select-content') return new Element(String(year));
      const button = new Element('');
      button.onClick = () => { year += selector.includes('prev') ? -1 : 1; };
      return button;
    };
    panel.querySelectorAll = selector => selector !== '.phoenix-calendar-month-panel-month' ? [] :
      Array.from({ length: 12 }, (_, i) => {
        const cell = new Element(`${i + 1}月`);
        cell.onClick = () => {
          clicks.push([year, i + 1]);
          if (commit) shown.textContent = `${year}-${String(i + 1).padStart(2, '0')}`;
        };
        return cell;
      });
  };
  render();
  const select = new Element('');
  select.querySelectorAll = selector => selector === '.phoenix-calendar-month-calendar' ? [panel] : [];
  select.querySelector = () => null;
  entry.element = select;
  entry.element.querySelectorAll = selector => selector === '.phoenix-calendar-month-calendar' ? [panel] : [shown];
  const context = {
    HTMLElement: Element, HTMLInputElement: Input,
    MouseEvent: class {}, Event: class {}, KeyboardEvent: class {},
    document: { querySelectorAll: () => [], body: new Element(), activeElement: null },
    window: { setTimeout }, isVisible: () => true, getPhoenixFieldLabel: () => '开始时间',
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function inferPickerInputType('), source.indexOf('  function isVisible(')), context);
  vm.runInContext(source.slice(source.indexOf('  async function fillPhoenixSelect('), source.indexOf('  function findExactPhoenixSelectOption(')), context);
  return { context, entry, shown, clicks: () => clicks };
}

test('month-precision picker walks the years and picks the month for an education row', async () => {
  const f = monthFixture();
  // 计划值即使完整到日，也该按控件精度只用年月
  assert.equal(await f.context.fillPhoenixSelect(f.entry, '2023-09-19'), true);
  assert.equal(f.shown.textContent, '2023-09');
  assert.deepEqual(f.clicks(), [[2023, 9]]);
  assert.equal(f.entry.fillError, '');
});

test('month-precision picker also accepts a bare year-month plan', async () => {
  const f = monthFixture();
  assert.equal(await f.context.fillPhoenixSelect(f.entry, '2019-09'), true);
  assert.equal(f.shown.textContent, '2019-09');
});

test('month picker that never commits is reported as unconfirmed, not as success', async () => {
  const f = monthFixture({ commit: false });
  assert.equal(await f.context.fillPhoenixSelect(f.entry, '2025-06'), false);
  assert.equal(f.entry.fillError, '网页未确认目标月份');
  assert.deepEqual(f.clicks(), [[2025, 6]]);
});

test('month picker with an unusable plan is refused before touching the calendar', async () => {
  const f = monthFixture();
  assert.equal(await f.context.fillPhoenixSelect(f.entry, '待定'), false);
  assert.match(f.entry.fillError, /年月/);
  assert.deepEqual(f.clicks(), []);
});

test('day-precision picker still uses the day calendar when no month calendar is shown', async () => {
  const f = fixture();
  assert.equal(await f.context.fillPhoenixSelect(f.entry, '2005-02-15'), true);
  assert.equal(f.shown.textContent, '2005-02-15');
  assert.equal(f.dayClicks(), 1);
});

test('month calendar detection ignores look-alike layers without the month calendar class', () => {
  const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
  const start = content.indexOf('  function isMonthCalendarPanel(');
  const end = content.indexOf('  async function confirmPhoenixMonthCalendar(');
  class Element {
    constructor(className) { this.className = className; this.isConnected = true; }
  }
  const c = { HTMLElement: Element, isVisible: () => true };
  vm.createContext(c);
  vm.runInContext(content.slice(start, end), c);
  const dayLike = new Element('phoenix-calendar phoenix-calendar-date-panel');
  assert.equal(c.isMonthCalendarPanel(dayLike), false);
  assert.equal(c.isMonthCalendarPanel(new Element('phoenix-calendar phoenix-calendar-month-calendar')), true);
});

function workYearsResolver() {
  const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
  const start = content.indexOf('  function parsePhoenixDate(');
  const end = content.indexOf('  async function confirmPhoenixCalendarDate(');
  const profile = require(path.join(projectDir, 'profile-fields.js'));
  const c = { self: { ResumeProProfile: profile } };
  vm.createContext(c);
  vm.runInContext(content.slice(start, end), c);
  return c;
}

test('工作年限 is derived from 参加工作时间 instead of trusting the AI guess', () => {
  const c = workYearsResolver();
  // 真实档案：参加工作时间 2027/06/01（还没开始工作）→ 应届毕业生，而不是 AI 说的「10年及以上」
  const future = { values: {}, custom: [{ key: '参加工作时间', value: '2027/06/01' }] };
  assert.equal(c.resolveWorkYears({ label: '工作年限' }, future), '应届毕业生');
  assert.equal(c.resolveWorkYears({ label: '工作经验' }, future), '应届毕业生');
  // 已经工作满 3 年
  const past = { values: { workStart: '2023-08-01' }, custom: [] };
  assert.equal(c.resolveWorkYears({ label: '工作年限' }, past), '3年');
  // 不足一年也算应届
  const recent = { values: { workStart: '2026-05-01' }, custom: [] };
  assert.equal(c.resolveWorkYears({ label: '工作年限' }, recent), '应届毕业生');
  // 不是这个字段、或档案没有参加工作时间 → 交给 AI
  assert.equal(c.resolveWorkYears({ label: '自我评价' }, future), null);
  assert.equal(c.resolveWorkYears({ label: '工作年限' }, { values: {}, custom: [] }), null);
});

test('占位文本永远不会写进网页', () => {
  const c = workYearsResolver();
  for (const value of ['此处姓名', '此处工作单位', '某某公司', 'XXX', '']) {
    assert.equal(c.isPlaceholderFillValue(value), true, `${value} 不该写进网页`);
  }
  for (const value of ['王小明', '华北理工大学', '无', '应届毕业生', '3.56/4.0']) {
    assert.equal(c.isPlaceholderFillValue(value), false, `${value} 是正常数据`);
  }
});


test("侧边栏读到的每份「我的信息」都带着自己那份基础信息，不会串到全局那份", () => {
  const content = fs.readFileSync(path.join(projectDir, "content.js"), "utf8");
  const start = content.indexOf("  function normalizeStore(");
  const templateStart = content.indexOf("  function normalizeTemplate(");
  const templateEnd = content.indexOf("\n  function ", templateStart + 10);
  assert.ok(start > 0 && templateStart > start && templateEnd > templateStart, "能在 content.js 里定位到这两段");

  // content.js 有自己的 normalizeStore（和 popup.js 是两份实现），单独切出来跑。
  const source = content.slice(start, templateStart) + content.slice(templateStart, templateEnd);
  const sandbox = {
    self: {
      ResumeProProfile: {
        normalizeProfile: (raw) => ({
          values: { ...((raw && raw.values) || {}) },
          education: [],
          family: [],
          custom: []
        })
      }
    }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`${source}\nglobalThis.normalizeStore = normalizeStore;`, context);

  const store = sandbox.normalizeStore({
    templates: [
      { id: "hw", name: "硬件方向", groups: [], profile: { values: { emergencyPhone: "13800001111" } } },
      { id: "sw", name: "软件方向", groups: [], profile: { values: { emergencyPhone: "13900002222" } } }
    ],
    activeTemplateId: "sw",
    profile: { values: { emergencyPhone: "15832632356" } }
  });

  assert.equal(store.templates[0].profile.values.emergencyPhone, "13800001111", "硬件那份带自己的电话");
  assert.equal(store.templates[1].profile.values.emergencyPhone, "13900002222", "软件那份带自己的电话");
  assert.equal(store.profile.values.emergencyPhone, "15832632356", "全局那份原样留着");
  assert.equal(store.activeTemplateId, "sw");

  // 老数据（条目里没有 profile）退回全局那份，等于一次性迁移
  const legacy = sandbox.normalizeStore({
    templates: [{ id: "old", name: "旧模板", groups: [] }],
    activeTemplateId: "old",
    profile: { values: { name: "共用" } }
  });
  assert.equal(legacy.templates[0].profile.values.name, "共用");
});


test("填完之后会回读一次，写进去被网页清掉时如实报出来（不是默默算成功）", () => {
  const content = fs.readFileSync(path.join(projectDir, "content.js"), "utf8");

  // ③ 假成功：写值返回 true 只代表「调用了 setter」，组合控件（证件号码那类）会在事件之后把值清掉。
  assert.match(content, /async function valueSurvives\(element, value\)/, "要有回读函数");
  assert.match(content, /if \(filled && isReadableInput\(element\)\) \{/, "写完要回读");
  assert.match(content, /await writeThroughComponent\(element\.element, fillValue\)/, "被清掉要换写法重写一次");
  assert.match(content, /element\.fillError = "网页把值清掉了，请手动粘贴"/, "两次都留不住要如实报错");
  assert.match(content, /if \(String\(element\.value\)\.trim\(\)\) return true;/, "回读只判断被清空，不把网页格式化当成失败");
});

test("联动下拉的选项异步加载时等它出现，覆盖 phoenix 组件而不只是原生 select", () => {
  const content = fs.readFileSync(path.join(projectDir, "content.js"), "utf8");

  // ④ 一级学科是 phoenix 组件（kind=custom-select），旧的重试只认 HTMLSelectElement 且只有 450ms。
  assert.match(content, /function isSelectLike\(entry\) \{/, "要有「下拉类字段」判断");
  assert.match(content, /if \(entry\.kind === "custom-select"\) return true;/, "phoenix 组件也算下拉");
  assert.match(content, /async function fillSelectWhenOptionsArrive\(entry, value, fieldMeta, button, fieldLabel\)/, "要等选项到位再填");
  assert.match(content, /const deadline = Date\.now\(\) \+ 6000;/, "等待时长要够（实测选项加载要几秒）");
  assert.match(content, /readSelectOptions\(entry\)/, "要能读原生与组件两种选项");
  assert.match(content, /等待网页加载「\$\{fieldLabel\}」的选项/, "等待期间要有明确提示");
  assert.doesNotMatch(content, /for \(let retry = 0; retry < 3; retry\+\+\) \{\n\s+await new Promise\(\(resolve\) => setTimeout\(resolve, 150\)\);/,
    "旧的 450ms 重试已经删掉");
});


test("证件号码这类字段留到最后一个写，并且按行重新查 DOM（网页重渲染会换掉输入框节点）", () => {
  const content = fs.readFileSync(path.join(projectDir, "content.js"), "utf8");

  // 机制：写完号码后点一下「性别」，号码就没了，且没有任何代码去清它 —— 是节点被网页重渲染换掉了。
  assert.match(content, /const deferredIdFields = \[\];/, "要有延迟写入清单");
  assert.match(content, /证件号码\|证件号\|身份证号\|身份证号码\|护照号\|护照号码/, "证件类字段要按名字识别出来");
  assert.match(content, /deferredIdFields\.push\(\{ label: fieldLabel, value: fillValue \}\)/, "循环里先跳过并记下来");
  assert.match(content, /function findInputByLabelText\(labelText\)/, "要能按行文本重新找输入框");
  assert.match(content, /await writeThroughComponent\(input, item\.value\)/, "最后一个一个重写");
  assert.match(content, /saved = Boolean\(fresh && String\(fresh\.value \?\? ""\)\.trim\(\)\)/, "写完重新查 DOM 再读（不用旧节点）");
  assert.match(content, /网页上没找到这个输入框/, "找不到和「被清掉」要分开报");
});
