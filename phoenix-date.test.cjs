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
  const { PROFILE_SCHEMA, FAMILY_FIELDS } = require(path.join(projectDir, 'profile-fields.js'));
  const fields = PROFILE_SCHEMA.flatMap(group => group.fields);
  for (const id of ['birth', 'graduation', 'availableDate']) {
    assert.equal(fields.find(field => field.id === id).type, 'date');
  }
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
    { key: '姓名', value: '模板姓名' },
    { key: '出生年月', value: '2005-02-15' },
    { key: '邮箱', value: 'a@example.com' },
  ]);
});

test('fill loop uses configured complete date instead of an AI month-only match', () => {
  const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
  assert.match(content, /const fillValue = preferredConfiguredDate\(fieldMeta, match\.value, profileFields\)/);
  assert.match(content, /let filled = setElementValue\(element, fillValue\)/);
  assert.match(content, /function preferredConfiguredDate\(/);
});
