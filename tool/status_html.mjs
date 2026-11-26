#!/usr/bin/env node
// 收尾状态文档 HTML 快照生成器（长期规则：AGENTS.md「收尾状态文档」同步生成同名 .html）。
//
// 用法：
//   node tool/status_html.mjs [源.md] [出.html]        默认 STATUS.md → STATUS.html（同目录）
//   node tool/status_html.mjs --check                  只校验既有 .html 与 .md 正文逐字一致
//   node tool/status_html.mjs --no-embed               图片不 base64 内嵌（只写相对路径）
//
// 口径（用户卡）：
//   * **单文件、可双击本地打开**：CSS 全部内嵌，零外部资源（无 CDN / 无外链脚本 / 无 webfont）。
//   * **内容与 md 逐字一致**：正文不增删一字；机器自检 = 把 md 剥掉语法标记后的可见文本
//     与 HTML 正文剥掉标签、还原实体后的可见文本逐字符比对（空白折叠后），
//     打印 `TEXT_IDENTICAL chars=<n>`；不一致直接退出码 1 并打印首个分歧上下文。
//     比对前两侧统一删掉 `*` / backtick / `_` 三类**标记符**与**全部空白**（定稿口径见
//     normalizeVisible 的注释）⇒ 可见文字一字不差才绿；换行位置/代码体首尾空白的漂移降为
//     次判据，只打印 `WS_SENSITIVE_*` 不判红。
//   * **目录锚点导航**：按 h2/h3 生成侧栏目录，锚点 id 为 `sec-<序号>`（CJK 友好，不靠 slug）。
//   * **顶部注明源文件与生成时间**：`<header>` 给出源文件名、生成时刻（含时区）、源文件
//     sha256 与字节数、脚本版本；页脚同样回填，便于「审 html 内容没问题再提交」。
//   * **本地图片**：md 里引用的同目录/相对路径图片默认 base64 内嵌（`--no-embed` 关闭），
//     内嵌后双击必显示；文件缺失则保留 alt 文本并打印告警。
//
// 依赖：仅 node builtins（fs / path / crypto），与 kernel-rs/js/gate/*.mjs 同口径，
// 这样任何项目 / CI 都能零安装直接跑。支持的 Markdown 面：ATX 标题、有序/无序嵌套列表、
// 引用块、围栏代码块、表格、分隔线、段落、行内代码、粗体、斜体、链接、图片。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const GENERATOR = 'tool/status_html.mjs v1.2';
const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const EMBED_IMAGES = !argv.includes('--no-embed');
const positional = argv.filter((a) => !a.startsWith('--'));
const SRC = positional[0] || 'STATUS.md';
const OUT = positional[1] || SRC.replace(/\.md$/i, '') + '.html';

/** HTML 文本/属性转义（正文一律先转义再做行内替换，杜绝内核读数里的 < > & 破坏结构）。 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 行内替换：先抠出行内代码占位，再转义，最后按 图片 → 链接 → 粗体 → 斜体 → 代码 顺序回填。 */
function inline(src, { imageWarnings, embed }) {
  const codes = [];
  // 行内代码**允许跨行**（台账里长 CSS/命令常被折行写在 `…` 里），自检侧用同一条整体正则。
  let s = src.replace(/(`+)([^`]+?)\1/g, (_m, _fence, body) => {
    codes.push(body.replace(/^\s+|\s+$/g, ''));
    return `\u0000C${codes.length - 1}\u0000`;
  });
  s = esc(s);
  // 图片 ![alt](path)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, target) => {
    if (/^(https?:|data:)/i.test(target)) return `<img src="${target}" alt="${alt}">`;
    const abs = path.resolve(path.dirname(SRC), decodeURIComponent(target));
    if (!embed) return `<img src="${target}" alt="${alt}">`;
    if (!fs.existsSync(abs)) {
      imageWarnings.push(target);
      return alt || '';
    }
    const buf = fs.readFileSync(abs);
    const mime = mimeFor(abs);
    return `<img src="data:${mime};base64,${buf.toString('base64')}" alt="${alt}">`;
  });
  // 链接 [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, target) => {
    const href = /^(https?:|#|mailto:)/i.test(target) ? target : target;
    return `<a href="${href}">${text}</a>`;
  });
  // 粗体（** 与 __ 两种写法）
  // 粗体一律**不跨行**（自检侧用同样的 [^*\n]）：台账里 `packages/**` 这类字面星号很常见，
  // 跨行匹配会把「字面 ** + 下一段的真粗体」连成一坨吃掉。
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
  // 斜体：只在前后不粘字母/数字/另一个星号时生效，避免 `2 * 3`、`-P 3` 这类误判
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?![_\w])/g, '$1<em>$2</em>');
  // 代码体以外的换行 → 硬换行（代码体内的换行原样留在 <code> 里）
  s = s.replace(/\n/g, '<br>');
  // 回填行内代码
  s = s.replace(/\u0000C(\d+)\u0000/g, (_m, i) => `<code>${esc(codes[Number(i)])}</code>`);
  return s;
}

function mimeFor(p) {
  const e = path.extname(p).toLowerCase();
  return (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
    }[e] || 'application/octet-stream'
  );
}

/** 块级解析：返回 { html, toc, imageWarnings }。 */
function renderMarkdown(md, { embed }) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const imageWarnings = [];
  const ctx = { imageWarnings, embed };
  const out = [];
  const toc = [];
  let i = 0;
  let secIndex = 0;

  // 列表项：`  - text` / `1. text`（缩进 2 空格一层，递归下钻）
  const LI = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  function isBlockStart(line) {
    return (
      /^```/.test(line) ||
      /^#{1,6}\s/.test(line) ||
      /^>\s?/.test(line) ||
      /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) ||
      /^\|/.test(line)
    );
  }

  function renderList(startIdx) {
    // 返回 [html, nextIdx]。按「缩进 + 标记类型」分组，嵌套靠递归。
    const items = [];
    let idx = startIdx;
    const baseIndent = (lines[idx].match(LI)[1] || '').length;
    const ordered = /\d/.test(lines[idx].match(LI)[2]);
    while (idx < lines.length) {
      const line = lines[idx];
      const m = line.match(LI);
      if (m && m[2].replace(/\d/g, '#') === lines[startIdx].match(LI)[2].replace(/\d/g, '#')) {
        const indent = (m[1] || '').length;
        if (indent < baseIndent) break;
        if (indent === baseIndent) {
          items.push({ text: m[3], children: null, order: ordered ? m[2].replace(/[.)]/, '') : null });
          idx++;
          // 后续更深缩进行（子列表或续行）交给递归
          continue;
        }
      }
      if (m && indentOtherMarker(m, baseIndent)) break;
      if (m) {
        // 同层但标记类型变了（- → 1.）⇒ 另起一个列表
        break;
      }
      if (/^\s*$/.test(line)) {
        // 空行：后面还是更深缩进 ⇒ 列表内续行；否则列表结束
        const next = lines[idx + 1];
        if (next && LI.test(next) && (next.match(LI)[1] || '').length > baseIndent) {
          idx++;
          continue;
        }
        if (next && /^\s{2,}\S/.test(next) && !isBlockStart(next) && items.length) {
          // 空行 + 更深缩进的续行：必须同时吃掉这两行（idx += 2）。
          // 旧实现只 idx++ 吃掉空行，下一轮又把 next 当普通续行追加一次 ⇒ 该行重复两遍。
          idx += 2;
          items[items.length - 1].text += '\n' + next.trim();
          continue;
        }
        break;
      }
      if (/^\s{2,}\S/.test(line) && !isBlockStart(line) && items.length) {
        items[items.length - 1].text += '\n' + line.trim();
        idx++;
        continue;
      }
      break;
    }
    // 递归处理每项内部可能出现的子列表（在已消费区间之外重新扫描一遍原文）
    let html = ordered ? '<ol>' : '<ul>';
    for (const it of items) html += `<li>${inline(it.text, ctx)}</li>`;
    html += ordered ? '</ol>' : '</ul>';
    return [html, idx];
  }

  function indentOtherMarker(m, baseIndent) {
    return (m[1] || '').length === baseIndent;
  }

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    // 围栏代码块
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++; // 收尾 ```
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const id = `sec-${secIndex++}`;
      out.push(`<h${level} id="${id}">${inline(h[2], ctx)}</h${level}>`);
      if (level === 2 || level === 3) toc.push({ level, id, text: stripInline(h[2]) });
      i++;
      continue;
    }
    // 分隔线
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    // 引用块
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(body.join('\n'), { embed, nested: true }).html}</blockquote>`);
      continue;
    }
    // 表格（首行 |a|b| + 次行 |---|---|）
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const cells = (l) =>
        l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim(), ctx));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`
      );
      continue;
    }
    // 列表
    if (LI.test(line)) {
      const [html, next] = renderList(i);
      out.push(html);
      i = next;
      continue;
    }
    // 段落（连续非块级行合并；行尾两个空格 = 硬换行）
    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i]) && !LI.test(lines[i])) {
      para.push(lines[i++].replace(/\s+$/, ''));
    }
    out.push(`<p>${inline(para.join('\n'), ctx)}</p>`);
  }
  return { html: out.join('\n'), toc, imageWarnings };
}

/** 目录里用纯文本（去掉 md 行内标记）。 */
function stripInline(s) {
  return s
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

/** md → 可见文本（剥语法标记），用于「逐字一致」自检。与渲染侧同序：先围栏、再行内代码、最后逐行剥行首标记。 */
function mdVisibleText(md) {
  let text = md.replace(/\r\n/g, '\n');
  // ① 围栏代码块：只留内容（``` 标记行本身不是可见文字）
  text = text.replace(/^```.*\n([\s\S]*?)^```[ \t]*$/gm, (_m, body) => body);
  // ② 行内代码（允许跨行，与渲染侧 inline() 同一条正则）⇒ 必须在逐行剥标记之前
  text = text.replace(/`+([^`]+?)`+/g, '$1');
  // （粗体/斜体的剥离在下面逐行阶段，与渲染侧「不跨行」口径一致）
  // ③ 逐行剥行首/行内标记
  const out = [];
  for (const raw of text.split('\n')) {
    let s = raw;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(s)) s = '';
    // 表格：分隔行不可见，数据行按「单元格之间一个空格」还原（正文里的 `||` 不能当分隔符吃）
    if (/^\|[\s:|-]+\|\s*$/.test(s)) s = '';
    else if (/^\|.*\|\s*$/.test(s)) s = s.replace(/^\|/, '').replace(/\|\s*$/, '').replace(/\|/g, ' ');
    s = s
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
      .replace(/__([^_\n]+?)__/g, '$1')
      .replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1$2');
    out.push(s);
  }
  return collapse(out.join('\n'));
}

/** HTML 正文 → 可见文本（去标签、还原实体、去 base64 图片数据），并保持与 md 相同的行结构。 */
function htmlVisibleText(html) {
  let s = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/data:[^"' )]*/g, '')
    // 行内/行间的空白必须还原成分隔符，否则「|a|b|」表格与列表项会被粘成一坨
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<\/(tr|li|p|h[1-6]|pre|blockquote|ul|ol|table|div|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  return collapse(s);
}

/**
 * 自检归一化（定稿口径，分两层）：
 *
 * ① **主判据**（决定退出码）：两侧各自得到可见文本后，删掉 `*` / backtick / `_` 三类标记符
 *    与**全部空白**，再逐字符比对。可见文字必须一字不差，标点、数字、英文标识符全部参与比对。
 * ② **次判据**（只打印 `WS_SENSITIVE_*`，不影响退出码）：同样删标记符但保留空白结构后比对。
 *
 * 为什么要删标记符（不能配对式比对，历史分歧样本见 M3-T284 块）：
 *   台账里常见「粗体跨行、而换行恰好落在一个跨行行内代码里」的写法。渲染侧先把行内代码整体
 *   抠成占位符（连同其中那个换行一起藏起来），`**…**` 于是落在同一行、配对成功输出 `<strong>`；
 *   自检侧只剥反引号、保留换行，同一对象标记就不配对（粗体/斜体刻意「不跨行」：台账里
 *   `packages/**` 这类字面星号太常见，跨行匹配会整段吃正文）。两侧对「对象标记算不算强调」
 *   天然可以判定不同，而可见文字必须相同。
 *
 * 为什么主判据还要删空白：本仓 md 里有**反引号不配对**的历史行（例：一行的行尾开了
 * `edgeLines.drawn 的代码、下一行的行首又开一个），不同解析器对「哪两个反引号是一对」判定不同，
 * 于是「换行落在代码体内还是代码体外」两侧可以不同；渲染侧又会 `trim()` 代码体首尾空白。
 * 这些都是空白层面的漂移，不是正文增删 ⇒ 降为次判据打印，主判据不受影响。
 * ⇒ 效果：渲染器多吃/少吃正文照红，多吃/少吃标记或挪动空白不误报。
 */
function normalizeVisible(s) {
  const stripped = s.replace(/[*`_]/g, '');
  return { wsFree: stripped.replace(/\s+/g, ''), collapsed: collapse(stripped) };
}

function collapse(s) {
  return s
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '')
    .join('\n');
}

const CSS = `
:root{color-scheme:light dark;--fg:#1c1f24;--fg-soft:#4b5563;--bg:#fbfbfd;--panel:#fff;--line:#d9dce3;--accent:#2b5fd9;--code:#f2f4f8;}
@media (prefers-color-scheme:dark){:root{--fg:#e6e8ee;--fg-soft:#a7afbd;--bg:#16181d;--panel:#1e2128;--line:#33373f;--accent:#7aa2ff;--code:#242833;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 ui-sans-serif,system-ui,"Noto Sans CJK SC","Microsoft YaHei",sans-serif;}
.wrap{display:flex;align-items:flex-start;gap:24px;max-width:1360px;margin:0 auto;padding:20px;}
nav.toc{position:sticky;top:12px;flex:0 0 300px;max-height:calc(100vh - 24px);overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;}
nav.toc h2{font-size:14px;margin:0 0 8px;letter-spacing:.02em;color:var(--fg-soft)}
nav.toc ol{list-style:none;margin:0;padding:0}
nav.toc li{margin:2px 0}
nav.toc a{color:var(--fg-soft);text-decoration:none;display:block;padding:2px 6px;border-radius:6px;font-size:13px}
nav.toc a:hover{background:var(--code);color:var(--fg)}
nav.toc li.l3 a{padding-left:18px;font-size:12.5px}
main{flex:1 1 auto;min-width:0;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:22px 28px 40px}
header.meta{border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:18px;color:var(--fg-soft);font-size:13px}
header.meta b{color:var(--fg)}
h1{font-size:26px;margin:.2em 0 .6em}
h2{font-size:21px;margin:1.6em 0 .6em;padding-bottom:.25em;border-bottom:1px solid var(--line)}
h3{font-size:17.5px;margin:1.4em 0 .5em}
h4,h5,h6{font-size:15.5px;margin:1.2em 0 .4em}
h2,h3,h4,h5,h6{scroll-margin-top:12px}
a{color:var(--accent)}
code{background:var(--code);padding:.08em .35em;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;word-break:break-word}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow:auto}
pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:2px 14px;border-left:3px solid var(--accent);color:var(--fg-soft);background:var(--code);border-radius:0 8px 8px 0}
ul,ol{padding-left:1.45em}
li{margin:.18em 0}
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:14px}
th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}
th{background:var(--code)}
hr{border:0;border-top:1px solid var(--line);margin:22px 0}
footer.meta{margin-top:26px;padding-top:12px;border-top:1px solid var(--line);color:var(--fg-soft);font-size:12.5px}
img{max-width:100%;height:auto}
@media (max-width:900px){.wrap{flex-direction:column}nav.toc{position:static;flex:0 0 auto;max-height:280px;width:100%}}
`;

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const a = Math.abs(offMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
    `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
  );
}

function buildHtml(md) {
  const { html, toc, imageWarnings } = renderMarkdown(md, { embed: EMBED_IMAGES });
  const srcBuf = fs.readFileSync(SRC);
  const sha = crypto.createHash('sha256').update(srcBuf).digest('hex');
  const stamp = nowStamp();
  const nav = toc
    .map((t) => `<li class="l${t.level}"><a href="#${t.id}">${esc(t.text)}</a></li>`)
    .join('\n');
  const head =
    `<header class="meta">源文件：<b>${esc(path.basename(SRC))}</b>` +
    `（${srcBuf.length} 字节 / ${md.split('\n').length} 行 · sha256 <code>${sha}</code>）<br>` +
    `本 HTML 由 <code>${GENERATOR}</code> 于 <b>${stamp}</b> 生成；` +
    `单文件、内嵌 CSS、零外部资源，可直接双击本地打开。<br>` +
    `正文与 md <b>逐字一致</b>（自检口径见页脚：剥掉三类标记符与空白后逐字符比对）；`
    + `审校无误后方可提交。</header>`;
  const bodyHtml = `<main>${head}\n<article id="hol-status-md">\n${html}\n</article></main>`;
  const footSha = crypto.createHash('sha256').update(html).digest('hex');
  const foot =
    `<footer class="meta">生成时刻 ${stamp} · 源 ${esc(path.basename(SRC))} sha256 <code>${sha}</code>` +
    ` · 正文 HTML sha256 <code>${footSha}</code> · 目录项 ${toc.length} 条 · 生成器 ${GENERATOR}<br>`
    + `自检口径：md 剥语法标记 vs HTML 去标签还原实体，两侧各删掉 <code>*</code> / <code>&#96;</code> / <code>_</code> 标记符与全部空白后`
    + `逐字符比对（主判据，结论 <code>TEXT_IDENTICAL</code> / <code>STATUS_HTML_CHECK_PASS</code>）；`
    + `保留空白结构的次判据只打印 <code>WS_SENSITIVE_*</code> 不判红，详见生成器注释。</footer>`;
  const doc =
    `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">\n` +
    `<meta name="generator" content="${GENERATOR}">\n` +
    `<title>${esc(path.basename(SRC))} · HTML 快照（${stamp}）</title>\n` +
    `<style>${CSS}</style>\n</head>\n<body>\n<div class="wrap">\n` +
    `<nav class="toc" aria-label="目录"><h2>目录（${toc.length}）</h2><ol>\n${nav}\n</ol></nav>\n` +
    `${bodyHtml}\n${foot}\n</div>\n</body>\n</html>\n`;
  return { doc, mdOnly: html, imageWarnings, sha, stamp, footSha, tocCount: toc.length };
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let k = 0;
  while (k < n && a[k] === b[k]) k++;
  if (k === n && a.length === b.length) return -1;
  return k;
}

/** 主判据：去标记符 + 去空白后逐字符比对；次判据：保留空白结构，只打印不判红。 */
function reportIdentical(mdText, bodyText) {
  const m = normalizeVisible(mdText);
  const h = normalizeVisible(bodyText);
  let ok = true;
  const k = firstDiff(m.wsFree, h.wsFree);
  if (k < 0) {
    console.log(`TEXT_IDENTICAL chars=${m.wsFree.length}`);
  } else {
    ok = false;
    const ctx = (t) => JSON.stringify(t.slice(Math.max(0, k - 70), k + 70));
    console.log(`TEXT_DIFF at=${k}（去标记符、去空白后的第 ${k} 个字符）`);
    console.log(`  md  : ${ctx(m.wsFree)}`);
    console.log(`  html: ${ctx(h.wsFree)}`);
  }
  const kw = firstDiff(m.collapsed, h.collapsed);
  if (kw < 0) {
    console.log(`WS_SENSITIVE_MATCH lines=${m.collapsed.split('\n').length}`);
  } else {
    const ctx = (t) => JSON.stringify(t.slice(Math.max(0, kw - 60), kw + 60));
    console.log(
      `WS_SENSITIVE_DIFF at=${kw}（仅空白/换行位置不同，正文一致 ⇒ 不判红）\n` +
        `  md  : ${ctx(m.collapsed)}\n  html: ${ctx(h.collapsed)}`,
    );
  }
  return ok;
}

const md = fs.readFileSync(SRC, 'utf8');
if (CHECK_ONLY) {
  const body = fs.readFileSync(OUT, 'utf8');
  const m = body.match(/<article id="hol-status-md">([\s\S]*?)<\/article>/);
  if (!m) {
    console.error(`CHECK_FAIL 未找到正文容器 <article id="hol-status-md">（请重新生成 ${OUT}）`);
    process.exit(1);
  }
  const ok = reportIdentical(mdVisibleText(md), htmlVisibleText(m[1]));
  console.log(ok ? `STATUS_HTML_CHECK_PASS ${OUT}` : `STATUS_HTML_CHECK_FAIL ${OUT}`);
  process.exit(ok ? 0 : 1);
}

const built = buildHtml(md);
fs.writeFileSync(OUT, built.doc);
const ok = reportIdentical(mdVisibleText(md), htmlVisibleText(built.mdOnly));
if (built.imageWarnings.length) {
  console.log(`IMAGE_MISSING x${built.imageWarnings.length}: ${built.imageWarnings.join(', ')}`);
}
console.log(
  `STATUS_HTML_WRITTEN ${OUT} bytes=${Buffer.byteLength(built.doc)} toc=${built.tocCount} ` +
    `embed_images=${EMBED_IMAGES ? 'base64' : 'off'} src_sha256=${built.sha.slice(0, 16)} ` +
    `generated_at="${built.stamp}"`
);
console.log(ok ? `STATUS_HTML_CHECK_PASS ${OUT}` : `STATUS_HTML_CHECK_FAIL ${OUT}`);
process.exit(ok ? 0 : 1);
