const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PROJECT_DIR = path.join(__dirname, "..");
const content = fs.readFileSync(path.join(PROJECT_DIR, "content.js"), "utf8");

function sliceFunction(source, name) {
  const starts = [`  function ${name}(`, `  async function ${name}(`]
    .map((needle) => source.indexOf(needle))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  if (!starts.length) throw new Error(`content.js 里找不到 ${name}`);
  const end = source.indexOf("\n  }\n", starts[0]);
  return source.slice(starts[0], end + 4);
}

// 够用的假 DOM：只回答“这条选项算不算已勾选”这个问题需要的东西。
class FakeElement {
  constructor(tag, { className = "", attrs = {}, children = [], text = "" } = {}) {
    this.tagName = tag.toUpperCase();
    this.className = className;
    this.attributes = { ...attrs };
    this.children = children;
    this.ownText = text;
    this.parentElement = null;
    this.isConnected = true;
    this.computed = { display: "block", visibility: "visible", opacity: "1" };
    this.rect = { width: 14, height: 14, top: 0, left: 0, right: 14, bottom: 14 };
    children.forEach((child) => { child.parentElement = this; });
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  hasClass(name) {
    return String(this.className || "").split(/\s+/).includes(name);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  // 只有 content.js 里实际用到的两个选择器需要被支持
  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      node.children.forEach((child) => {
        if (selector.includes("svg.RadioChecked") && child.tagName === "SVG" && child.hasClass("RadioChecked")) found.push(child);
        else if (selector.includes("svg.RadioChecked") && child.hasClass("RadioChecked")) found.push(child);
        if (selector.includes("input[type='radio']:checked")
          && child.tagName === "INPUT" && child.checked === true) found.push(child);
        visit(child);
      });
    };
    visit(this);
    return found;
  }
}

function fakeSvg({ visibility = "hidden", display = "inline", opacity = "1", width = 14 } = {}) {
  const svg = new FakeElement("svg", { className: "RadioChecked" });
  svg.computed = { display, visibility, opacity };
  svg.rect = { width, height: 14, top: 0, left: 0, right: 14, bottom: 14 };
  return svg;
}

function loadDeepestNodeRule() {
  const context = { console };
  context.self = context;
  context.globalThis = context;
  context.window = { getComputedStyle: (element) => element.computed };
  context.HTMLElement = FakeElement;
  vm.createContext(context);
  vm.runInContext(`${sliceFunction(content, "normalizeAutocompleteText")}\n${sliceFunction(content, "phoenixDeepestLabelNode")}\nthis.deepest = phoenixDeepestLabelNode;`, context);
  return context.deepest;
}

function loadRule() {
  const context = { console };
  context.self = context;
  context.globalThis = context;
  context.window = { getComputedStyle: (element) => element.computed };
  context.HTMLElement = FakeElement;
  vm.createContext(context);
  vm.runInContext(`${sliceFunction(content, "isVisible")}\n${sliceFunction(content, "phoenixItemShowsSelected")}\nthis.showsSelected = phoenixItemShowsSelected;`, context);
  return context.showsSelected;
}

test("Phoenix 选项：勾选图标常驻 DOM 但被 CSS 隐藏时不算已选", () => {
  const showsSelected = loadRule();
  // 组件把图标都画出来、只用 visibility 控制显隐：这时插件如果当成“已勾选”，就会跳过点击，
  // 于是出现“搜索出来了却选不中”，并且确认判定还会把没落库的填写误报成成功。
  const hiddenIconItem = new FakeElement("div", { className: "list-item-container", children: [fakeSvg({ visibility: "hidden" })] });
  assert.equal(showsSelected(hiddenIconItem), false);
  const zeroSizeItem = new FakeElement("div", { className: "list-item-container", children: [fakeSvg({ visibility: "visible", width: 0 })] });
  assert.equal(showsSelected(zeroSizeItem), false);
  const transparentItem = new FakeElement("div", { className: "list-item-container", children: [fakeSvg({ visibility: "visible", opacity: "0" })] });
  assert.equal(showsSelected(transparentItem), false);
});

test("Phoenix 选项：真正显示出来的勾选图标仍然算已选", () => {
  const showsSelected = loadRule();
  const shownIconItem = new FakeElement("div", { className: "list-item-container", children: [fakeSvg({ visibility: "visible" })] });
  assert.equal(showsSelected(shownIconItem), true);
});

test("Phoenix 选项：组件写在 DOM 上的选中状态同样算已选", () => {
  const showsSelected = loadRule();
  assert.equal(showsSelected(new FakeElement("div", { attrs: { "aria-selected": "true" } })), true);
  assert.equal(showsSelected(new FakeElement("div", { attrs: { "aria-checked": "true" } })), true);
  assert.equal(showsSelected(new FakeElement("div", { className: "list-item-container is-selected" })), true);
  const stateOnParent = new FakeElement("div", { className: "list-item-container" });
  const wrapper = new FakeElement("div", { className: "phoenix-select-item--checked", children: [stateOnParent] });
  assert.equal(showsSelected(stateOnParent), true);
  const checkedRadio = new FakeElement("div", { className: "list-item-container" });
  const radio = new FakeElement("input", { attrs: { type: "radio" } });
  radio.checked = true;
  checkedRadio.children.push(radio);
  radio.parentElement = checkedRadio;
  assert.equal(showsSelected(checkedRadio), true);
  assert.ok(wrapper);
});

test("Phoenix 选项：没有任何选中痕迹时不算已选", () => {
  const showsSelected = loadRule();
  assert.equal(showsSelected(new FakeElement("div", { className: "list-item-container" })), false);
  assert.equal(showsSelected(null), false);
});

test("选中要点行首那个单选圆圈（真机实测：点整行、点文字都不生效）", () => {
  // 2026-09-19 在 bocd.zhiye.com 的民族选择器上逐个目标试过：
  // 整行、.item-text-label、最深的文字节点、甚至 CDP 可信点击 —— 都不选中；
  // 只有 .icon-container（行首那个圆圈）会把它选上。所以点击目标列表里圆圈必须排在最前，
  // 并且每试一个都要用网页自己的状态确认，不能点完就算完成。
  const block = content.slice(content.indexOf("if (!isPhoenixSelectorItemSelected(option)) {"), content.indexOf("const accepted = await confirmPhoenixSelectionIfNeeded"));
  const iconIndex = block.indexOf('option.querySelector(".icon-container")');
  const iconSvgIndex = block.indexOf('option.querySelector(".icon-container svg")');
  const deepestIndex = block.indexOf("phoenixDeepestLabelNode(label, value)");
  const rowIndex = block.indexOf("option\n          ].filter(Boolean)");
  assert.ok(iconIndex > -1, "要点行首的单选圆圈");
  assert.ok(iconSvgIndex > iconIndex, "圆圈里的 svg 作为第二候选");
  assert.ok(deepestIndex > iconSvgIndex, "文字节点只作为后面的兜底");
  assert.ok(block.includes("dispatchPhoenixPointerClick(target);"), "目标统一走同一套指针事件序列");
  assert.ok(block.includes("const marked = await waitPhoenixState"), "每试一个目标都要等网页确认");
  assert.ok(block.includes("if (marked) break;"), "确认成功才停手");
  assert.ok(rowIndex > -1 || block.includes("].filter(Boolean);"), "整行作为最后一个兜底");
});

test("指针事件序列和真人点一下一致", () => {
  const fn = content.slice(content.indexOf("function dispatchPhoenixPointerClick"), content.indexOf("function phoenixDeepestLabelNode"));
  assert.ok(fn.includes("fire(\"pointerdown\", PointerEvent)"), "缺少 pointerdown");
  assert.ok(fn.includes("fire(\"mousedown\", MouseEvent)"), "缺少 mousedown");
  assert.ok(fn.includes("fire(\"mouseup\", MouseEvent)"), "缺少 mouseup");
  assert.ok(fn.includes("target.click()"), "缺少 click（svg 上 fallback 到 click 事件）");
  assert.ok(fn.includes('else fire("click", MouseEvent)'), "svg 没有 click() 时要补一个 click 事件");
});

test("点击会落在选项里最深的文字节点上，事件照样冒泡到整条选项", () => {
  const deepest = loadDeepestNodeRule();
  // 真实站点（bocd.zhiye.com）的选项是 .list-item-container > .item-text-label.no-hover > span > span
  const inner = new FakeElement("span", { text: "汉族" });
  const wrapper = new FakeElement("span", { children: [inner] });
  const label = new FakeElement("span", { className: "item-text-label no-hover", children: [wrapper] });
  const item = new FakeElement("div", { className: "list-item-container", children: [label] });
  assert.equal(deepest(label, "汉族"), inner, "要一路下钻到最里层的文字节点");
  assert.equal(deepest(item, "汉族"), inner, "从整条选项进来也要下钻到同一个节点");
  // 文字直接写在 label 上时，就停在 label 自己身上
  const plain = new FakeElement("span", { className: "item-text-label", text: "汉族" });
  assert.equal(deepest(plain, "汉族"), plain);
});

test("浮层定位按关键字找，认得出 portal / select__list 这类命名", () => {
  assert.match(content, /function phoenixPopupScope\(node\)/);
  assert.match(content, /const pattern = \/layer\|popup\|popper\|dropdown\|overlay\|portal\|selector\|select-\?list\|selectList\|select__list\|panel\/i;/);
  assert.match(content, /const targets = \[/);
  assert.match(content, /function dispatchPhoenixPointerClick\(target\)/);
  assert.match(content, /const marked = await waitPhoenixState\(\(\) => \{/);
  assert.match(content, /const current = findExactPhoenixSelectOption\(value\);/);
  assert.match(content, /const layer = phoenixPopupScope\(option\);/);
  assert.match(content, /\|\| \(layer \? \(!layer\.isConnected \|\| !isVisible\(layer\)\) : false\), 8, 120\);/);
});

test("点击选项之后必须确认真的落库，不能凭有确定按钮就当成功", () => {
  assert.match(content, /const accepted = await confirmPhoenixSelectionIfNeeded\(select, value\)/);
  assert.match(content, /const settled = await waitPhoenixState\(\(\) => phoenixSelectHasValue\(select, value\)/);
  assert.match(content, /if \(accepted && settled\) return true;/);
  assert.match(content, /网页未确认已选中，请手动选择/);
  assert.ok(!content.includes("if (!accepted || !settled) {"), "不能再是「试一次就报失败」，要能重扫再来");
});

test("异步重建列表的组件要能重扫重试，而不是点一次就放弃", () => {
  // 真机实测（bocd.zhiye.com 民族）：写进搜索框后列表整段重建，第一次点到的行会作废；
  // 重扫一次再点就成了。所以「找 → 点 → 确认 → 核对」必须留在 30 次的重试循环里。
  const loop = content.slice(content.indexOf("for (let attempt = 0; attempt < 30; attempt += 1) {"), content.indexOf("function parsePhoenixDate"));
  assert.ok(loop.includes("const option = findExactPhoenixSelectOption(value);"), "每轮都要重新按文字找行");
  assert.ok(loop.includes("if (accepted && settled) return true;"), "确认成功才 return");
  assert.ok(loop.includes("// 这一版组件筛选是异步的"), "要写明为什么重试");
  assert.match(content, /entry\.fillError = "网页未确认已选中，请手动选择";\n    input\.dispatchEvent\(new KeyboardEvent\("keydown"/, "循环用满后如实报未确认");
});

test("「已选」区域里的展示行不算选项，优先带单选圆圈的选项行", () => {
  assert.match(content, /const isSelectableItem = \(item\) => item instanceof HTMLElement && !item\.closest\("\.select-data-container"\);/);
  assert.match(content, /const itemsWithIcon = selectorLabelItems\.filter\(\(item\) => item\.querySelector\("\.icon-container"\)\);/);
  assert.match(content, /const preferredItems = itemsWithIcon\.length \? itemsWithIcon : selectorLabelItems;/);
});

test("“已勾选”的判定只有一处实现，确认面板复用同一条规则", () => {
  assert.match(content, /function phoenixItemShowsSelected\(item\)/);
  assert.match(content, /function isPhoenixSelectorItemSelected\(item\) \{\n    return phoenixItemShowsSelected\(item\);\n  \}/);
  assert.match(content, /\.some\(\(item\) => phoenixItemShowsSelected\(item\)\n        && normalizeAutocompleteText\(item\.querySelector\("\.item-text-label"\)\?\.textContent\) === expected\)/);
});

test("浮层搜索框认不出类名时退回到浮层内唯一那个输入框", () => {
  assert.match(content, /if \(!searchInputs\.length\) \{/);
  assert.match(content, /searchInputs = inputs\.length === 1 \? inputs : \[\];/);
});

test("确认按钮只点最深那一层，不点外面的祖先节点", () => {
  const fn = sliceFunction(content, "findSelectionConfirmationButton");
  // 真机上处理器只挂在最深那层（.phoenix-button__wraper--primary）；事件只向上冒泡，
  // 点祖先等于没点 —— 那正是“已选好了却提交不上”的原因。
  assert.ok(!fn.includes('directButton.closest(".phoenix-button")'), "不能再向上爬到 .phoenix-button");
  assert.ok(fn.includes("if (directButton) return directButton;"));
  assert.ok(fn.includes(".phoenix-button__wraper"));
  assert.ok(fn.includes("button.contains(other)"));
});

test("点确认按钮用的是和点选项同一套指针事件序列", () => {
  const fn = sliceFunction(content, "confirmPhoenixSelectionIfNeeded");
  assert.ok(fn.includes("dispatchPhoenixPointerClick(confirmButton);"));
});
